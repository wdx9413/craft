import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodingAdapter } from "../core/coding-adapter.ts";
import { OfficeAdapter } from "../core/office-adapter.ts";
import { GeneralEvolutionKernel } from "../core/general-evolution.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-domain-adapters-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const kernel = new GeneralEvolutionKernel(store);
  kernel.ensureAdapters();
  return { root, store, kernel, coding: new CodingAdapter(kernel), office: new OfficeAdapter(kernel) };
}

test("coding adapter extracts scoped repair know-how and blocks unrelated text", async () => {
  const f = await fixture();
  try {
    const hit = f.coding.capture({ statement: "构建报错时先运行 pnpm test 再修 patch", scope: { kind: "project", id: "project:a" }, evidence_ids: ["e1"] }) as Record<string, unknown>;
    assert.equal(hit.status, "candidate");
    assert.equal((hit.candidate as Record<string, unknown>).domain, "coding");
    const miss = f.coding.capture({ statement: "我偏好深色模式" }) as Record<string, unknown>;
    assert.equal(miss.status, "ignored");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("office adapter records principal scope for shared-memory governance", async () => {
  const f = await fixture();
  try {
    const hit = f.office.capture({ statement: "会议决议：文档模板先走审批", principal_id: "alice",
      scope: { kind: "project", id: "project:ops" }, evidence_ids: ["meeting-1"] }) as Record<string, unknown>;
    assert.equal(hit.status, "candidate");
    const candidate = hit.candidate as Record<string, unknown>;
    assert.equal((candidate.scope as Record<string, unknown>).principal_id, "alice");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("failure candidates require attribution and evidence", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.kernel.captureFailureCandidate({ failure_class: "unattributed", remedy: "retry" }), /attributed/);
    assert.throws(() => f.kernel.captureFailureCandidate({ failure_class: "selector_drift", remedy: "wait for selector" }), /evidence/);
    const candidate = f.kernel.captureFailureCandidate({ failure_class: "selector_drift", remedy: "wait for selector", evidence_ids: ["e1"] }) as Record<string, unknown>;
    assert.equal(candidate.status, "diagnostic");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("program memory promotion and invocation feedback are gated", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence", "obs1", { source_type: "test", claim: "verified fix", confidence: "bounded" });
    f.store.create("evidence", "obs2", { source_type: "test", claim: "verified fix again", confidence: "bounded" });
    const candidate = f.kernel.captureProgramMemory({ statement: "验证过的修复步骤", steps: ["run test"], evidence_ids: ["obs1"] }) as Record<string, unknown>;
    assert.throws(() => f.kernel.promoteProgramMemory({ id: candidate.id, evaluation_ref: "eval-1" }), /not submitted/);
    f.kernel.captureProgramMemory({ statement: "验证过的修复步骤", steps: ["run test"], evidence_ids: ["obs2"] });
    f.kernel.submitProgramMemory(String(candidate.id));
    const promoted = f.kernel.promoteProgramMemory({ id: candidate.id, evaluation_ref: "eval-1" }) as Record<string, unknown>;
    assert.equal(promoted.status, "promoted");
    const degraded = f.kernel.recordProgramMemoryFeedback({ id: candidate.id, outcome: "degraded" }) as Record<string, unknown>;
    assert.equal(degraded.status, "rejected");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
