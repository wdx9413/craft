import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contextFeedbackWeights } from "../core/context-feedback-weight.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

async function openStore(): Promise<{ store: CraftStore; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "craft-feedback-weight-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { store, root };
}

function helpful(store: CraftStore, id: string, member: string, target: string, verified = true): void {
  store.create("context_feedback", id, { outcome: "helpful", evidence_verified: verified,
    asset_refs: [{ member, id: target, version: 1, digest: "sha256:" + "a".repeat(64) }] });
}

function correction(store: CraftStore, id: string, member: string, target: string, outcome = "incorrect", status = "pending_review"): void {
  store.create("context_correction_task", id, { status, outcome, asset_ref: { member, id: target, version: 1 } });
}

test("feedback weights are neutral with no ids or no signals", async () => {
  const { store, root } = await openStore();
  try {
    assert.equal(contextFeedbackWeights(store, "knowledge", []).size, 0);
    const neutral = contextFeedbackWeights(store, "knowledge", ["k1"]).get("k1")!;
    assert.deepEqual(neutral, { weight: 1, penalty: 1, positive: 0, negative: 0 });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("verified helpful feedback raises the weight and unverified feedback is ignored", async () => {
  const { store, root } = await openStore();
  try {
    helpful(store, "f1", "knowledge", "k1");
    helpful(store, "f2", "knowledge", "k1");
    helpful(store, "f3", "knowledge", "k1", false);
    const weight = contextFeedbackWeights(store, "knowledge", ["k1"]).get("k1")!;
    assert.equal(weight.positive, 2);
    assert.equal(weight.weight, 1.4);
    assert.equal(weight.penalty, 1);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("pending incorrect or stale corrections lower the weight until resolved", async () => {
  const { store, root } = await openStore();
  try {
    correction(store, "c1", "knowledge", "k1", "incorrect");
    correction(store, "c2", "knowledge", "k1", "stale");
    correction(store, "c3", "knowledge", "k1", "incorrect", "resolved");
    correction(store, "c4", "knowledge", "k1", "incorrect", "confirmed");
    correction(store, "c5", "knowledge", "k1", "stale", "dismissed");
    const weight = contextFeedbackWeights(store, "knowledge", ["k1"]).get("k1")!;
    assert.equal(weight.negative, 3);
    assert.equal(weight.weight, 0.4);
    assert.equal(weight.penalty, 0.4);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("feedback for another member or id is ignored", async () => {
  const { store, root } = await openStore();
  try {
    helpful(store, "f1", "memory", "k1");
    helpful(store, "f2", "knowledge", "k2");
    correction(store, "c1", "memory", "k1");
    correction(store, "c2", "knowledge", "k2");
    const weight = contextFeedbackWeights(store, "knowledge", ["k1"]).get("k1")!;
    assert.deepEqual(weight, { weight: 1, penalty: 1, positive: 0, negative: 0 });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("weights clamp at the documented bounds", async () => {
  const { store, root } = await openStore();
  try {
    for (let index = 0; index < 8; index += 1) helpful(store, `p${index}`, "experience", "e1");
    for (let index = 0; index < 8; index += 1) correction(store, `n${index}`, "experience", "e2");
    const weights = contextFeedbackWeights(store, "experience", ["e1", "e2"]);
    assert.equal(weights.get("e1")!.weight, 2);
    assert.equal(weights.get("e1")!.penalty, 1);
    assert.equal(weights.get("e2")!.weight, 0.25);
    assert.equal(weights.get("e2")!.penalty, 0.25);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("malformed asset reference lists are ignored", async () => {
  const { store, root } = await openStore();
  try {
    store.create("context_feedback", "f1", { outcome: "helpful", evidence_verified: true, asset_refs: "not-an-array" });
    const weight = contextFeedbackWeights(store, "knowledge", ["k1"]).get("k1")!;
    assert.deepEqual(weight, { weight: 1, penalty: 1, positive: 0, negative: 0 });
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
