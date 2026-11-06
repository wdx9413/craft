import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-templates-"));
  const store = await new CraftStore(craftPaths(join(root, "data"))).open();
  return { root, store, service: new CraftService(store) };
}

test("executor templates bind provider/model/permission/budget without execution authority", async () => {
  const f = await fixture();
  try {
    const saved = f.service.executorTemplateSave({ executor_template_id: "exec-1", name: "Local craft", provider: "craft",
      model: "gateway-1", permission: "auto", capability_ids: ["c1"], budget: { max_tokens: 1000 } }) as JsonObject;
    assert.equal(saved.execution_authority, false);
    assert.equal(saved.provider, "craft");
    assert.deepEqual(saved.capability_ids, ["c1"]);
    assert.equal((f.service.executorTemplateGet({ executor_template_id: "exec-1" }) as JsonObject).model, "gateway-1");
    assert.equal(((f.service.executorTemplateList({ query: "craft" }) as JsonObject).templates as JsonObject[]).length, 1);
    assert.throws(() => f.service.executorTemplateSave({ name: "bad", provider: "nope", permission: "auto" }), /provider/);
    assert.throws(() => f.service.executorTemplateSave({ name: "bad", provider: "craft", permission: "nope" }), /permission/);
    assert.throws(() => f.service.executorTemplateSave({ name: "bad", provider: "craft", permission: "auto", capability_ids: "x" }), /capability_ids/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("supervisor profiles allow deterministic pause/block rules but the model only advises", async () => {
  const f = await fixture();
  try {
    const saved = f.service.supervisorProfileSave({ supervisor_profile_id: "sup-1", name: "Default", supervision_model: "gpt",
      deterministic_rules: [{ id: "r1", condition: "effect == destructive", action: "block" }, { id: "r2", condition: "ci_failed", action: "pause" }],
      rubric: ["tests pass", "no secrets"] }) as JsonObject;
    assert.equal(saved.advisory_only, true);
    assert.equal(saved.execution_authority, false);
    assert.deepEqual((saved.deterministic_rules as JsonObject[]).map((rule) => rule.action), ["block", "pause"]);
    assert.equal((f.service.supervisorProfileGet({ supervisor_profile_id: "sup-1" }) as JsonObject).supervision_model, "gpt");
    assert.equal(((f.service.supervisorProfileList({}) as JsonObject).profiles as JsonObject[]).length, 1);
    assert.throws(() => f.service.supervisorProfileSave({ name: "bad", deterministic_rules: [{ id: "r", condition: "c", action: "allow" }] }), /pause or block/);
    assert.throws(() => f.service.supervisorProfileSave({ name: "bad", deterministic_rules: "x" }), /array/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
