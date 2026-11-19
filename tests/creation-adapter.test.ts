import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CreationAdapter } from "@craft/capability-context";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-creation-adapter-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, adapter: new CreationAdapter(store) };
}

test("creation adapter routes text image video and slides by artifact type", () => {
  for (const artifactType of ["text", "image", "video", "slides"] as const) {
    const routed = CreationAdapter.route({ artifact_type: artifactType });
    assert.equal(routed.artifact_type, artifactType);
    assert.equal(routed.route, "artifact_type");
  }
  assert.equal(CreationAdapter.route({ modality: "visual" }).modality, "visual");
  assert.equal(CreationAdapter.route({ modality: "video" }).modality, "video");
  assert.throws(() => CreationAdapter.route({}), /artifact_type or modality is required/);
  assert.throws(() => CreationAdapter.route({ modality: "audio" }), /unsupported modality/);
});

test("artifact lineage stores references and metadata without copying large bodies", async () => {
  const f = await fixture();
  try {
    const body = "x".repeat(3000);
    const recorded = f.adapter.write({ id: "poster", artifact_type: "image", source_refs: ["asset://sketch", "asset://brand"],
      prompt: "Generate a poster", parameters: { size: "1024x1024" }, tool: "image-model", version: 2,
      user_choice: "accepted", evaluation: "good composition", reliability: 0.9,
      scope: { scope_kind: "project", scope_id: "creation:campaign" }, body }) as Record<string, unknown>;
    assert.equal(recorded.artifact_type, "image");
    assert.equal(recorded.modality, "visual");
    assert.equal(recorded.requested_version, 2);
    const stored = JSON.stringify(f.store.list("artifact_lineage", 10, undefined, false));
    assert.equal(stored.includes(body), false);
    assert.equal(stored.includes("asset://sketch"), true);
    assert.equal(stored.includes("Generate a poster"), true);
    assert.equal(stored.includes("image-model"), true);
    assert.equal(stored.includes("accepted"), true);
    assert.equal(stored.includes("good composition"), true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("recall routes by modality first and falls back to artifact type", async () => {
  const f = await fixture();
  try {
    f.adapter.write({ id: "article", artifact_type: "text", source_refs: ["asset://beach"], prompt: "beach" });
    f.adapter.write({ id: "clip", artifact_type: "video", source_refs: ["asset://footage"], prompt: "beach" });
    const routed = f.adapter.recall({ modality: "video", prompt: "beach" }) as { route: string; items: Record<string, unknown>[] };
    assert.equal(routed.route, "modality");
    assert.deepEqual(routed.items.map((item) => item.id), ["artifact_lineage_clip"]);
    const typed = f.adapter.recall({ artifact_type: "text" }) as { route: string; items: Record<string, unknown>[] };
    assert.equal(typed.route, "artifact_type");
    assert.deepEqual(typed.items.map((item) => item.id), ["artifact_lineage_article"]);
    f.adapter.write({ id: "malformed", artifact_type: "text", source_refs: ["asset://beach"], prompt: "beach" });
    const record = f.store.find("artifact_lineage", "artifact_lineage_malformed") as Record<string, unknown>;
    f.store.save("artifact_lineage", "artifact_lineage_malformed", { ...record, source_refs: "asset://beach" });
    const malformed = f.adapter.recall({ modality: "text", prompt: "beach" }) as { items: Record<string, unknown>[] };
    assert.equal(malformed.items.some((item) => item.id === "artifact_lineage_malformed"), true);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("low reliability and conflicting lineage abstain instead of ranking", async () => {
  const f = await fixture();
  try {
    f.adapter.write({ id: "low", artifact_type: "text", source_refs: ["asset://draft"], reliability: 0.2 });
    const low = f.adapter.recall({ artifact_type: "text", prompt: "draft" }) as { abstain: boolean; reason: string; items: unknown[] };
    assert.equal(low.abstain, true);
    assert.equal(low.reason, "low_reliability");
    assert.deepEqual(low.items, []);
    f.adapter.write({ id: "conflict-v1", artifact_type: "text", source_refs: ["asset://old"], tool: "old-model" });
    f.adapter.write({ id: "conflict-v2", artifact_type: "text", source_refs: ["asset://new"], tool: "new-model" });
    const conflict = f.adapter.recall({ artifact_type: "text" }) as { abstain: boolean; reason: string; downweighted: string[]; items: unknown[] };
    assert.equal(conflict.abstain, true);
    assert.equal(conflict.reason, "conflicting_lineage");
    assert.equal(conflict.downweighted.length, 2);
    assert.equal(new Set(conflict.downweighted).has("artifact_lineage_conflict-v1"), true);
    assert.equal(new Set(conflict.downweighted).has("artifact_lineage_conflict-v2"), true);
    assert.deepEqual(conflict.items, []);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("creation write apply forget and scope leak stay inside one scope", async () => {
  const f = await fixture();
  try {
    const scope = { scope_kind: "project", scope_id: "creation:poster" };
    f.adapter.write({ id: "kept", artifact_type: "slides", source_refs: ["asset://deck"], prompt: "launch deck", scope });
    const applied = f.adapter.apply({ id: "kept", scope }) as { status: string; domain: string; artifact_type: string };
    assert.equal(applied.status, "applied");
    assert.equal(applied.domain, "creation");
    assert.equal(applied.artifact_type, "slides");
    const leaked = f.adapter.recall({ scope: { scope_kind: "project", scope_id: "creation:other" }, artifact_type: "slides" }) as { items: unknown[] };
    assert.deepEqual(leaked.items, []);
    f.adapter.forget({ id: "kept", scope });
    const forgotten = f.adapter.recall({ scope, artifact_type: "slides" }) as { items: unknown[] };
    assert.deepEqual(forgotten.items, []);
    f.adapter.write({ id: "clip", artifact_type: "video", source_refs: ["asset://clip"], scope });
    const routedApply = f.adapter.apply({ id: "artifact_lineage_clip", modality: "video", scope }) as { status: string };
    assert.equal(routedApply.status, "applied");
    const routedForget = f.adapter.forget({ id: "artifact_lineage_clip", modality: "video", scope }) as { status: string };
    assert.equal(routedForget.status, "forgotten");
    const deniedRecall = f.adapter.recall({ domain: "office", artifact_type: "video", scope }) as { status: string; reason: string; items: unknown[] };
    assert.equal(deniedRecall.status, "denied");
    assert.equal(deniedRecall.reason, "domain isolation");
    assert.deepEqual(deniedRecall.items, []);
    f.adapter.write({ id: "fast", artifact_type: "text", source_refs: ["asset://new"], reliability: 0.9, scope });
    f.adapter.write({ id: "same", artifact_type: "text", source_refs: ["asset://new"], reliability: 0.5, scope });
    const ranked = f.adapter.recall({ artifact_type: "text", scope }) as { items: Record<string, unknown>[] };
    assert.equal(ranked.items[0]?.id, "artifact_lineage_fast");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("creation adapter denies non-creation domains and invalid lineage input", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.adapter.write({ domain: "office", artifact_type: "text" }), { status: "denied", reason: "domain isolation" });
    assert.deepEqual(f.adapter.apply({ domain: "research", id: "x" }), { status: "denied", reason: "domain isolation" });
    assert.throws(() => f.adapter.write({ artifact_type: "audio" }), /unsupported artifact type/);
    assert.throws(() => f.adapter.write({ artifact_type: "text", user_choice: "maybe" }), /unsupported user choice/);
    assert.throws(() => f.adapter.write({ artifact_type: "text", reliability: 2 }), /reliability must be between 0 and 1/);
    assert.throws(() => f.adapter.write({ artifact_type: "text", scope: { scope_kind: "project" } }), /scope must declare/);
    assert.throws(() => f.adapter.write({ artifact_type: "text", version: 0 }), /version must be a positive integer/);
    f.adapter.write({ id: "string-refs", artifact_type: "text", source_refs: "asset://bad" });
    const stringRefs = f.store.find("artifact_lineage", "artifact_lineage_string-refs") as Record<string, unknown>;
    assert.deepEqual(stringRefs.source_refs, []);
    assert.throws(() => f.adapter.apply({ scope: { scope_kind: "project", scope_id: "creation:x" } }), /id is required/);
    assert.throws(() => f.adapter.apply({ id: "missing", scope: { scope_kind: "project", scope_id: "creation:x" } }), /not in scope/);
    assert.throws(() => f.adapter.forget({ id: "missing", scope: { scope_kind: "project", scope_id: "creation:x" } }), /not in scope/);
    const deniedForget = f.adapter.forget({ domain: "research", id: "missing" }) as { status: string; reason: string };
    assert.deepEqual(deniedForget, { status: "denied", reason: "domain isolation" });
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
