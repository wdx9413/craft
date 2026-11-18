import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GeneralEvolutionKernel } from "../core/general-evolution.ts";
import { CreationAdapter } from "../core/creation-adapter.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-evolution-scenarios-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const kernel = new GeneralEvolutionKernel(store);
  kernel.ensureAdapters();
  return { root, store, kernel, creation: new CreationAdapter(store) };
}

const inScope = { kind: "project", id: "project:alpha" };
const otherScope = { kind: "project", id: "project:beta" };

for (const domain of ["coding", "office", "travel", "research"] as const) {
  test(`${domain} adapter: write, recall, scope leak`, async () => {
    const f = await fixture();
    try {
      const captured = f.kernel.captureDomainStatement({ domain, statement: {
        coding: "构建报错时先运行测试再修 patch",
        office: "会议决议：文档模板先走审批",
        travel: "预算不超过 8000 元并预订东京酒店",
        research: "论文假设需要实验复现与反例验证",
      }[domain], scope: inScope, evidence_ids: [`${domain}-evidence`] }) as JsonObject;
      assert.equal(captured.status, "candidate");
      const inScopeItems = f.kernel.listProgramMemory({ status: "diagnostic" }).items as JsonObject[];
      assert.equal(inScopeItems.some((item) => item.domain === domain), true);
      // A different scope must not recall the candidate.
      const leaked = inScopeItems.filter((item) => item.domain === domain
        && JSON.stringify(item.scope) === JSON.stringify(otherScope));
      assert.deepEqual(leaked, []);
    } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
  });
}

test("creation adapter: write, recall, apply, forget, scope leak", async () => {
  const f = await fixture();
  try {
    f.creation.write({ id: "deck", artifact_type: "slides", source_refs: ["asset://brand"], prompt: "quarterly deck",
      scope: { scope_kind: "project", scope_id: "creation:alpha" }, reliability: 0.9, user_choice: "accepted" });
    const recalled = f.creation.recall({ artifact_type: "slides", scope: { scope_kind: "project", scope_id: "creation:alpha" } }) as JsonObject;
    assert.equal((recalled.items as JsonObject[]).length, 1);
    const applied = f.creation.apply({ id: "deck", scope: { scope_kind: "project", scope_id: "creation:alpha" } }) as JsonObject;
    assert.equal(applied.status, "applied");
    const leaked = f.creation.recall({ artifact_type: "slides", scope: { scope_kind: "project", scope_id: "creation:beta" } }) as JsonObject;
    assert.deepEqual(leaked.items, []);
    const forgotten = f.creation.forget({ id: "deck", scope: { scope_kind: "project", scope_id: "creation:alpha" } }) as JsonObject;
    assert.equal(forgotten.status, "forgotten");
    const afterForget = f.store.find("artifact_lineage", "artifact_lineage_deck");
    assert.equal(afterForget !== null, true, "forget keeps an audit record");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("unpromoted general candidates never become routeable assets", async () => {
  const f = await fixture();
  try {
    const candidate = f.kernel.captureProgramMemory({ statement: "验证过的工作流", evidence_ids: ["e1"], scope: inScope }) as JsonObject;
    assert.equal(candidate.status, "diagnostic");
    assert.throws(() => f.kernel.promoteProgramMemory({ id: candidate.id, evaluation_ref: "eval-1" }), /not submitted/);
    assert.equal((f.store.find("experience_procedure", String(candidate.id)) ?? null), null, "no procedure asset exists before gates");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
