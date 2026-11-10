import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { AttentionKernel } from "../core/attention.ts";
import { attentionDecisionBrief } from "../core/attention-decision-brief.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "craft-attention-brief-"));
  const store = await new CraftStore(craftPaths(root)).open();
  return { root, store, kernel: new AttentionKernel(store) };
}

test("every listed card carries a complete structured decision brief", async () => {
  const f = await fixture();
  try {
    f.store.create("autonomy_request", "approval", { status: "pending_approval", task_id: "task", action: "external_write", target: "crm" });
    f.store.create("work_launch", "launch", { status: "awaiting_approval", task_id: "task", host: "codex-cli", workspace: "C:/work", sandbox: "workspace-write" });
    f.store.create("speculative_candidate", "draft", { status: "ready", task_id: "task", expires_at: "2030-01-02T00:00:00Z" });
    f.kernel.refresh({ now: "2030-01-01T00:00:00Z" });
    const items = f.kernel.list({ now: "2030-01-01T00:00:00Z" }).items as JsonObject[];
    assert.equal(items.length, 3);
    for (const item of items) {
      const brief = item.decision_brief as JsonObject;
      assert.ok(brief, `${item.id} must have a decision brief`);
      assert.equal(typeof brief.trigger, "string");
      assert.ok(String(brief.trigger).length > 0);
      assert.ok(brief.evidence && typeof brief.evidence === "object");
      assert.equal((brief.evidence as JsonObject).source_id, String(item.source_id));
      assert.ok(Array.isArray(brief.options));
      assert.ok((brief.options as unknown[]).length >= 2);
      assert.equal(typeof brief.impact, "string");
      assert.equal(typeof brief.recommendation, "string");
      assert.ok(Array.isArray(brief.uncertainty));
      assert.equal(typeof brief.source_stale, "boolean");
    }
    const approval = items.find((item) => item.action === "review_authorization")!;
    const approvalBrief = approval.decision_brief as JsonObject;
    assert.deepEqual((approvalBrief.options as Array<{ id: string }>).map((option) => option.id),
      ["approve_once", "reject", "remember"]);
    const candidate = items.find((item) => item.action === "review_speculative_candidate")!;
    assert.ok((candidate.decision_brief as JsonObject).uncertainty as string[]);
    assert.ok(((candidate.decision_brief as JsonObject).uncertainty as string[]).some((line) => line.includes("有效期")));
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

test("a card with a missing source reference refuses to recommend an action", () => {
  const brief = attentionDecisionBrief({
    reason: "An action requires approval", action: "review_authorization",
    source_kind: undefined, source_id: undefined, source_version: 1, source_status: "pending",
    task_id: "task", details: {},
  } as unknown as JsonObject);
  assert.equal(brief.source_stale, true);
  assert.match(brief.recommendation, /先刷新来源/u);
  assert.ok(brief.uncertainty.some((line) => line.includes("来源引用缺失")));
});

test("destructive options are surfaced in the impact statement", () => {
  const brief = attentionDecisionBrief({
    reason: "Rework reached its limit", action: "replan_with_evidence",
    source_kind: "task_run_state", source_id: "state", source_version: 2, source_status: "rework_limit",
    task_id: "task", details: { launch_id: "launch" },
  } as unknown as JsonObject);
  assert.match(brief.impact, /写入或返工/u);
  assert.equal(brief.source_stale, false);
  assert.ok(brief.options.some((option) => option.destructive));
  assert.match(brief.recommendation, /转交人工/u);
});

test("the brief is derived, not persisted: a source change is never hidden by a stale brief", async () => {
  const f = await fixture();
  try {
    f.store.create("autonomy_request", "approval", { status: "pending_approval", task_id: "task", action: "external_write", target: "crm" });
    f.kernel.refresh({ now: "2030-01-01T00:00:00Z" });
    const before = (f.kernel.list({ now: "2030-01-01T00:00:00Z" }).items as JsonObject[])[0]!;
    const firstBrief = before.decision_brief as JsonObject;
    assert.equal((firstBrief.evidence as JsonObject).source_version, 1);
    // The underlying source changes; the brief is recomputed from the card on
    // every list call, so no stored decision package can silently go stale.
    f.store.save("autonomy_request", "approval", { status: "pending_approval", task_id: "task", action: "external_write", target: "crm" });
    f.kernel.refresh({ now: "2030-01-01T00:00:01Z" });
    const after = (f.kernel.list({ now: "2030-01-01T00:00:02Z" }).items as JsonObject[])[0]!;
    const afterEvidence = (after.decision_brief as JsonObject).evidence as JsonObject;
    assert.equal(afterEvidence.source_version, 2, "the brief must reflect the refreshed source version");
    assert.equal(afterEvidence.source_status, "pending_approval");
    assert.notEqual(after.decision_brief, firstBrief, "the brief is recomputed, not the stored object reused");
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});
