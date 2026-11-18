import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GeneralEvolutionKernel } from "../core/general-evolution.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-general-evolution-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, kernel: new GeneralEvolutionKernel(store) };
}

test("domain adapters register deterministically and candidate adapters stay candidates", async () => {
  const f = await fixture();
  try {
    f.kernel.ensureAdapters();
    const first = f.kernel.ensureAdapters();
    assert.equal((first.items as unknown[]).length, 5);
    const candidate = f.kernel.registerAdapter({ name: "coding", version: "v2", extraction_patterns: ["repo"], value_threshold: 3 }) as Record<string, unknown>;
    assert.equal(candidate.status, "candidate");
    assert.equal(candidate.value_threshold, 3);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("program memory candidate is diagnostic until repetitions and evidence pass threshold", async () => {
  const f = await fixture();
  try {
    f.kernel.ensureAdapters();
    const first = f.kernel.captureProgramMemory({ statement: "先打开页面再点击登录", domain: "office", scope: { project: "demo" } }) as Record<string, unknown>;
    assert.equal(first.status, "diagnostic");
    assert.throws(() => f.kernel.submitProgramMemory(String(first.id)), /threshold/);
    f.store.create("evidence", "obs1", { source_type: "test", claim: "observed login flow", confidence: "bounded" });
    f.kernel.captureProgramMemory({ statement: "先打开页面再点击登录", domain: "office", scope: { project: "demo" }, evidence_ids: ["obs1"] });
    const submitted = f.kernel.submitProgramMemory(String(first.id)) as Record<string, unknown>;
    assert.equal(submitted.status, "submitted");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("artifact lineage stores metadata and recalls by artifact type with reliability floor", async () => {
  const f = await fixture();
  try {
    f.kernel.recordArtifactLineage({ artifact_type: "slides", source_refs: ["doc1"], prompt: "make a deck", parameters: { theme: "dark" }, tool: "slides", reliability: 0.9, user_choice: "accepted" });
    f.kernel.recordArtifactLineage({ artifact_type: "slides", source_refs: ["doc2"], reliability: 0.2 });
    const recalled = f.kernel.recallArtifactLineage({ artifact_type: "slides" }) as { items: unknown[] };
    assert.equal(recalled.items.length, 1);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("prospective intention records trigger outcomes and research links are typed", async () => {
  const f = await fixture();
  try {
    const intention = f.kernel.createProspectiveIntention({ intention: "明天提醒我提交报告", trigger: { date: "2026-11-18" } }) as Record<string, unknown>;
    const hit = f.kernel.fireProspectiveIntention({ id: String(intention.id), trigger: { date: "2026-11-18" } }) as Record<string, unknown>;
    assert.equal(hit.status, "delivered");
    const link = f.kernel.linkResearch({ source_id: "paper1", target_id: "exp1", relation: "derives_from", layer: "interpretation" }) as Record<string, unknown>;
    assert.equal(link.relation, "derives_from");
    assert.equal(link.layer, "interpretation");
    assert.throws(() => f.kernel.linkResearch({ source_id: "a", target_id: "b", relation: "likes" }), /unsupported/);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
