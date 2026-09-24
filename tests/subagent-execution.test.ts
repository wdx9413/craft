import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InternalHostDriver } from "../core/internal-host-driver.ts";
import { defineProvider } from "../core/model-gateway.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { executeSubagent, planSubagentExecution } from "../core/subagent-execution.ts";

/**
 * P0-3: a Sub-agent is an execution body, not only a governance record.
 *
 * The capability that was missing is a child loop with its *own* context window,
 * because "delegate and discard the intermediate transcript" is how a long run is
 * kept coherent. These tests hold the three properties that make it safe: the
 * child has an isolated session, no write authority, and a budget carved out of
 * what the parent has left.
 */

const spec = () => defineProvider({ provider: "demo", label: "Demo", protocol: "openai-compatible",
  base_url: "https://example.test/v1", api_key_env: "DEMO_API_KEY",
  models: { small: "demo-small", standard: "demo-std", frontier: "demo-frontier" } });

test("sub-agent planning refuses on depth, authority and empty parent budget", async () => {
  const accepted = planSubagentExecution({ parent_remaining_tokens: 10_000 });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.reason, "accepted");
  assert.equal(accepted.limits.depth, 1);
  assert.equal(accepted.limits.budget_tokens, 5_000);
  assert.equal(accepted.limits.max_steps, 8);

  // A child of a child is refused by default: delegation must not recurse freely.
  assert.equal(planSubagentExecution({ parent_depth: 1, parent_remaining_tokens: 10_000 }).reason, "subagent_depth_exhausted");
  // A sub-agent with write authority is refused outright, not downgraded silently.
  assert.equal(planSubagentExecution({ parent_remaining_tokens: 10_000, effect: "local_write" }).reason, "subagent_must_be_read_only");
  // A parent with nothing left cannot fund a child.
  assert.equal(planSubagentExecution({ parent_remaining_tokens: 100 }).reason, "insufficient_parent_budget");
  // The child's step and window ceilings never exceed the parent's.
  const bounded = planSubagentExecution({ parent_remaining_tokens: 100_000, parent_max_steps: 3,
    max_steps: 99, parent_max_context_tokens: 4_096, max_context_tokens: 999_999, budget_share: 0.25 });
  assert.equal(bounded.limits.max_steps, 3);
  assert.equal(bounded.limits.max_context_tokens, 4_096);
  assert.equal(bounded.limits.budget_tokens, 25_000);
  assert.throws(() => planSubagentExecution({ parent_remaining_tokens: 10_000, budget_share: 0 }), /budget_share/u);
  assert.throws(() => planSubagentExecution({ parent_remaining_tokens: 10_000, budget_share: 2 }), /budget_share/u);
  assert.throws(() => planSubagentExecution({ parent_remaining_tokens: 10_000, max_depth: 0 }), /max_depth/u);
  // The upper bounds and the empty-string guard are exercised too: a limit that is
  // only checked from below is not a limit.
  assert.throws(() => planSubagentExecution({ parent_remaining_tokens: 10_000, max_steps: 100_000 }), /max_steps/u);
  assert.throws(() => planSubagentExecution({ parent_remaining_tokens: 10_000, effect: "   " }), /effect must not be empty/u);
  // A refused plan is not executable.
  await assert.rejects(() => executeSubagent({ operation_id: "op", task_id: "t", objective: "look",
    plan: { accepted: false, reason: "subagent_depth_exhausted", limits: accepted.limits },
    prepare: () => ({}), execute: async () => ({}) }), /refused: subagent_depth_exhausted/u);
});
test("a sub-agent runs in its own session with a bounded share of the parent budget", async () => {
  const root = await mkdtemp(join(tmpdir(), `craft-subagent-${process.pid}-`));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("task", "parent-task", { title: "parent", goal: "delegate" });
    let childTurns = 0;
    const driver = new InternalHostDriver(store, { providers: [spec()],
      transport: { complete: async () => {
        childTurns += 1;
        // The child acts on its first turn and answers on its second, so the test
        // observes a real child loop rather than a single-shot completion.
        return childTurns === 1
          ? { text: "", model: "fake", usage: { input_tokens: 2, output_tokens: 3 },
              tool_calls: [{ id: "c1", type: "function" as const, function: { name: "capability_search", arguments: "{}" } }] }
          : { text: "child findings", model: "fake", usage: { input_tokens: 2, output_tokens: 3 } };
      } },
      invokeAction: async () => ({ found: true }) });
    const plan = planSubagentExecution({ parent_remaining_tokens: 4_000, parent_max_context_tokens: 4_096 });
    const report = await executeSubagent({ operation_id: "op-1", task_id: "parent-task",
      objective: "Inspect the checkout failure", plan,
      prepare: (args) => driver.prepare(args), execute: (args) => driver.execute(args) });

    assert.equal(report.status, "completed");
    assert.equal(report.depth, 1);
    assert.equal(report.isolated_session, true);
    assert.equal(report.execution_authority, false);
    assert.equal(report.final_message, "child findings");
    assert.match(String(report.receipt_digest), /^sha256:/u);
    assert.ok(report.steps >= 1, "the child ran no action of its own");
    assert.equal(report.tokens_used, 10);
    // The child's transcript lives under its own session key, so the parent's
    // session is untouched and the child's reasoning is not the parent's to read.
    const childSession = store.get("internal_session", report.session_id) as Record<string, unknown>;
    assert.equal(childSession.dispatch_id, report.dispatch_id);
    assert.equal(Boolean(store.find("internal_session", "session_op-1")), false);
    // Its declared ceiling is the pruned budget, not the parent's.
    const childDispatch = store.get("internal_dispatch", report.dispatch_id) as Record<string, unknown>;
    const limits = childDispatch.limits as Record<string, unknown>;
    assert.equal(limits.max_tokens, 2_000);
    assert.equal(limits.max_context_tokens, 4_096);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a failing child is reported as failed rather than thrown at the parent", async () => {
  const plan = planSubagentExecution({ parent_remaining_tokens: 4_000 });
  const report = await executeSubagent({ operation_id: "op-2", task_id: "t", objective: "look",
    plan, prepare: () => ({ dispatch: { id: "subagent_op-2" } }),
    execute: async () => ({ receipt: { status: "failed", failure: "transport exploded",
      final_message: null, loop: { steps: 2, tokens_used: 7 } } }) });
  assert.equal(report.status, "failed");
  assert.equal(report.failure, "transport exploded");
  assert.equal(report.final_message, null);
  assert.equal(report.steps, 2);
  assert.equal(report.tokens_used, 7);
  // A dispatch that never produced a receipt is not hashed into a fake digest, and
  // the prepared id is what the child is recorded under.
  const empty = await executeSubagent({ operation_id: "op-3", task_id: "t", objective: "look",
    plan, prepare: () => ({ dispatch: {} }), execute: async () => ({}) });
  assert.equal(empty.receipt_digest, null);
  assert.equal(empty.status, "failed");
  assert.equal(empty.dispatch_id, "subagent_op-3");
  assert.equal(empty.steps, 0);
  const missingDispatch = await executeSubagent({ operation_id: "op-4", task_id: "t", objective: "look",
    plan, prepare: () => ({}), execute: async () => ({ receipt: { status: "failed", loop: {} } }) });
  assert.equal(missingDispatch.dispatch_id, "subagent_op-4");
});
