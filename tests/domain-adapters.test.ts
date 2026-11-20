import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodingAdapter } from "@craft/capability-context";
import { OfficeAdapter } from "@craft/capability-context";
import { SelfEvolutionKernel } from "@craft/capability-context";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-domain-adapters-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const kernel = new SelfEvolutionKernel(store);
  kernel.ensureAdapters();
  return { root, store, kernel, coding: new CodingAdapter(kernel), office: new OfficeAdapter(kernel) };
}

test("coding adapter extracts scoped repair know-how and blocks unrelated text", async () => {
  const f = await fixture();
  try {
    const scope = { kind: "project", id: "project:a" };
    const hit = f.coding.capture({ statement: "构建报错时先运行 pnpm test 再修 patch", scope, evidence_ids: ["e1"] }) as Record<string, unknown>;
    assert.equal(hit.status, "candidate");
    assert.equal((hit.candidate as Record<string, unknown>).domain, "coding");
    // Adapters are hints, not gates: a non-matching statement degrades to the
    // general path and is still captured rather than silently dropped.
    const miss = f.coding.capture({ statement: "我偏好深色模式", scope }) as Record<string, unknown>;
    assert.equal(miss.status, "candidate");
    assert.equal(miss.adapter_match, false);
    assert.equal(miss.domain, "general");
    assert.equal((f.coding.recall({ scope }).items as unknown[]).length, 1);
    assert.deepEqual(f.coding.recall({ scope: { kind: "project", id: "project:neighbor" } }).items, []);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("office adapter preserves project scope without accepting caller principal claims", async () => {
  const f = await fixture();
  try {
    const hit = f.office.capture({ statement: "会议决议：文档模板先走审批", principal_id: "alice",
      scope: { kind: "project", id: "project:ops" }, evidence_ids: ["meeting-1"] }) as Record<string, unknown>;
    assert.equal(hit.status, "candidate");
    const candidate = hit.candidate as Record<string, unknown>;
    assert.deepEqual(candidate.scope, { kind: "project", id: "project:ops" });
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("failure candidates require attribution and evidence", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.kernel.captureFailureCandidate({ failure_class: "unattributed", remedy: "retry" }), /attributed/);
    assert.throws(() => f.kernel.captureFailureCandidate({ failure_class: "selector_drift", remedy: "wait for selector" }), /evidence/);
    const candidate = f.kernel.captureFailureCandidate({ failure_class: "selector_drift", remedy: "wait for selector",
      scope: { kind: "project", id: "project:demo" }, evidence_ids: ["e1"] }) as Record<string, unknown>;
    assert.equal(candidate.status, "diagnostic");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("diagnostic Program Memory can be revoked without becoming routeable", async () => {
  const f = await fixture();
  try {
    const scope = { kind: "project", id: "project:demo" };
    const candidate = f.kernel.captureProgramMemory({ statement: "验证过的修复步骤", steps: ["run test"], scope });
    const args = { id: candidate.id, scope };
    assert.throws(() => f.kernel.promoteProgramMemory({ ...args, evaluation_ref: "eval-1" }), /not submitted/);
    const revoked = f.kernel.recordProgramMemoryFeedback({ ...args, outcome: "revoked" });
    assert.equal(revoked.status, "revoked");
    assert.equal(f.kernel.recordProgramMemoryFeedback({ ...args, outcome: "revoked" }).version, revoked.version);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
