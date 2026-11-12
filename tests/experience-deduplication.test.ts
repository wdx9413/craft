import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from 'craft-common-store-local/store';
import { classifyVerdict, ExperienceDeduplicationKernel, factorKey, normalizeFactor } from "../core/experience-deduplication.ts";

test("factor normalization and dedupe keys ignore order and casing", () => {
  assert.equal(normalizeFactor("AmiHud_20"), "amihud_20");
  assert.equal(factorKey(["mom", "rev"]), factorKey(["REV", "Mom"]));
  assert.equal(factorKey(["mom", "rev"], "tech"), "tech::mom+rev");
  assert.equal(factorKey([]), "none");
});

test("verdict classification stays conservative and never invents a verdict", () => {
  assert.equal(classifyVerdict("这个因子组合已被证伪，跑输基准"), "rejected");
  assert.equal(classifyVerdict("显著改善，跑赢基准"), "accepted");
  assert.equal(classifyVerdict("我们改了参数但没结论"), "unknown");
  assert.equal(classifyVerdict(""), "unknown");
});

test("conclusions are deduplicated by factor combination and reinforce, not multiply", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-exp-dedup-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const kernel = new ExperienceDeduplicationKernel(store);
    const first = kernel.record({ factors: ["mom", "rev"], pool: "tech", title: "该组合已被证伪", source: "pitfalls" });
    assert.equal(first.idempotent, false);
    const duplicate = kernel.record({ factors: ["REV", "mom"], pool: "TECH", title: "该组合已被证伪", source: "pitfalls" });
    assert.equal(duplicate.idempotent, true);
    const duplicateConclusion = duplicate.conclusion as JsonObject;
    const firstConclusion = first.conclusion as JsonObject;
    assert.equal(duplicateConclusion.id, firstConclusion.id);
    const rows = store.list("experience_conclusion", 10_000);
    assert.equal(rows.length, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("a conflicting conclusion for the same combination is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-exp-dedup-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const kernel = new ExperienceDeduplicationKernel(store);
    kernel.record({ factors: ["vol"], pool: "", title: "有效", verdict: "accepted", source: "manual" });
    assert.throws(() => kernel.record({ factors: ["vol"], pool: "", title: "无效", verdict: "rejected", source: "manual" }), /conflicts with an existing record/u);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("findByFactors returns matching conclusions regardless of argument order", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-exp-dedup-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const kernel = new ExperienceDeduplicationKernel(store);
    kernel.record({ factors: ["mom", "rev"], pool: "tech", title: "显著改善" });
    kernel.record({ factors: ["skew"], pool: "tech", title: "无改善" });
    const found = kernel.findByFactors(["REV", "mom"], "tech");
    assert.equal(found.length, 1);
    assert.equal(found[0]!.verdict, "accepted");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("hasRefutedCombination blocks re-proposing an already-refuted intervention", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-exp-dedup-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const kernel = new ExperienceDeduplicationKernel(store);
    kernel.record({ factors: ["lowvol"], pool: "tech", title: "该组合跑输，已淘汰", source: "pitfalls" });
    assert.equal(kernel.hasRefutedCombination(["lowvol"], "tech"), true);
    assert.equal(kernel.hasRefutedCombination(["lowvol"], "bond"), false);
    assert.equal(kernel.hasRefutedCombination(["mom"], "tech"), false);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("recording rejects invalid input and classifies when verdict is omitted", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-exp-dedup-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    const kernel = new ExperienceDeduplicationKernel(store);
    assert.throws(() => kernel.record({ factors: [], pool: "" }), /at least one factor/u);
    assert.throws(() => kernel.record({ factors: ["mom"], pool: 7 }), /pool must be a string/u);
    assert.throws(() => kernel.record({ factors: ["mom"], verdict: "maybe" }), /verdict is unsupported/u);
    const classified = kernel.record({ factors: ["x"], title: "", evidence: "显著改善", pool: "" });
    assert.equal(classified.idempotent, false);
    assert.equal((classified.conclusion as JsonObject).verdict, "accepted");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
