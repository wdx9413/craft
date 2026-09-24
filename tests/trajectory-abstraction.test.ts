import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_INTERNAL_AUTHORIZATION, authorizedTools, classifyTool } from "../core/internal-tool-authorization.ts";
import { McpServer, TOOLS } from "../core/mcp.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import {
  abstractAcrossTrajectories,
  buildAbstraction,
  findRecurringFailures,
  trajectoryFailureSignature
} from "../core/trajectory-abstraction.ts";

const failing = (trace: string, task: string, checks: string[], observedAt = 0): JsonObject =>
  ({ trace_id: trace, task_id: task, failed_checks: checks, outcome: "failed", observed_at: observedAt });

test("v0.12.37 derives a signature from the failure set, not its order", () => {
  // Order independence is the point: the same failure reported in a different
  // sequence is still the same failure.
  assert.equal(trajectoryFailureSignature({ failed_checks: ["b", "a"] }), "a|b");
  assert.equal(trajectoryFailureSignature({ failed_checks: ["a", "b"] }), "a|b");
  // Duplicates collapse, so a check retried three times is one failure.
  assert.equal(trajectoryFailureSignature({ failed_checks: ["a", "a", "a"] }), "a");
  // A clean run has no signature and can never seed an abstraction.
  assert.equal(trajectoryFailureSignature({}), "");
  assert.equal(trajectoryFailureSignature({ failed_checks: [] }), "");
  assert.throws(() => trajectoryFailureSignature({ failed_checks: [""] }), /must not be empty/u);
});

test("v0.12.37 matches failures by check identity, not by task id", () => {
  // Running this against a real model exposed the hole: checks named per task
  // (`rev-1:exact`, `rev-2:exact`) are the same failure but never matched, so
  // recurrence across tasks was invisible and the floor could never be met.
  assert.equal(trajectoryFailureSignature({ failed_checks: ["rev-1:exact"] }), "exact");
  assert.equal(trajectoryFailureSignature({ failed_checks: ["rev-2:exact"] }), "exact");
  // The last separator wins, so a nested qualifier still reduces to the check.
  assert.equal(trajectoryFailureSignature({ failed_checks: ["a:b:exact"] }), "exact");
  // A name with no separator is already task-free and passes through.
  assert.equal(trajectoryFailureSignature({ failed_checks: ["tests"] }), "tests");
  // Whitespace around the tail is trimmed rather than becoming its own identity.
  assert.equal(trajectoryFailureSignature({ failed_checks: ["rev-1: exact "] }), "exact");
  // A separator with nothing meaningful after it falls back to the whole name,
  // so an odd name degrades to itself instead of vanishing.
  assert.equal(trajectoryFailureSignature({ failed_checks: ["rev-1:"] }), "rev-1:");
  assert.equal(trajectoryFailureSignature({ failed_checks: ["rev-1:   "] }), "rev-1:");

  // End to end: three distinct tasks failing the same way now group together.
  const analysis = findRecurringFailures({ trajectories: [
    failing("t1", "rev-1", ["rev-1:exact"], 1),
    failing("t2", "rev-2", ["rev-2:exact"], 2),
    failing("t3", "rev-3", ["rev-3:exact"], 3),
  ] });
  const candidates = analysis.candidates as JsonObject[];
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.signature, "exact");
  assert.equal(candidates[0]!.publishable, true);
  assert.equal(candidates[0]!.distinct_tasks, 3);
  // The statement names the kind of check, not whichever task ran first.
  assert.deepEqual(candidates[0]!.failed_checks, ["exact"]);
});

test("v0.12.37 generalises only across independent trajectories", () => {
  const analysis = findRecurringFailures({ trajectories: [
    failing("t1", "task-a", ["tests"], 1),
    failing("t2", "task-b", ["tests"], 2),
  ] });
  const candidates = analysis.candidates as JsonObject[];
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0]!.publishable, true);
  assert.equal(candidates[0]!.distinct_tasks, 2);
  assert.equal(candidates[0]!.reason, "recurrence_observed");
  assert.deepEqual(candidates[0]!.trace_ids, ["t1", "t2"]);
  assert.equal(analysis.publishable_count, 1);
  assert.equal(analysis.considered, 2);
});

test("v0.12.37 refuses to generalise one task retrying itself", () => {
  // The rule that keeps abstraction from becoming confident hallucination: two
  // attempts at the SAME task is one story told twice, not a pattern.
  const analysis = findRecurringFailures({ trajectories: [
    failing("t1", "task-a", ["tests"], 1),
    failing("t2", "task-a", ["tests"], 2),
  ] });
  const candidates = analysis.candidates as JsonObject[];
  assert.equal(candidates[0]!.publishable, false);
  assert.equal(candidates[0]!.reason, "single_task_recurrence");
  assert.equal(analysis.publishable_count, 0);
  assert.equal(analysis.sufficient_evidence, undefined);

  // And it cannot be forced through the build path.
  assert.throws(() => buildAbstraction({ trajectories: [failing("t1", "task-a", ["tests"]), failing("t2", "task-a", ["tests"])], signature: "tests" }),
    /not supported by enough independent trajectories: single_task_recurrence/u);
});

test("v0.12.37 needs at least two observations before anything is claimed", () => {
  const analysis = findRecurringFailures({ trajectories: [failing("t1", "task-a", ["tests"])] });
  const candidates = analysis.candidates as JsonObject[];
  assert.equal(candidates[0]!.publishable, false);
  assert.equal(candidates[0]!.reason, "insufficient_occurrences");

  // Nothing recurrent at all is a legitimate, expected answer.
  const empty = findRecurringFailures({ trajectories: [] });
  assert.deepEqual(empty.candidates, []);
  assert.equal(empty.publishable_count, 0);
  assert.equal(empty.considered, 0);
});

test("v0.12.37 groups by signature so distinct failures stay distinct", () => {
  const analysis = findRecurringFailures({ trajectories: [
    failing("t1", "task-a", ["tests"], 1),
    failing("t2", "task-b", ["tests"], 2),
    failing("t3", "task-c", ["lint"], 3),
    failing("t4", "task-d", ["lint"], 4),
    // A clean run is excluded entirely: success is not a lesson.
    { trace_id: "t5", task_id: "task-e", failed_checks: [], outcome: "succeeded", observed_at: 5 },
  ] });
  const candidates = analysis.candidates as JsonObject[];
  assert.equal(candidates.length, 2);
  const bySignature = new Map(candidates.map((candidate) => [String(candidate.signature), candidate]));
  assert.deepEqual(bySignature.get("tests")!.trace_ids, ["t1", "t2"]);
  assert.deepEqual(bySignature.get("lint")!.trace_ids, ["t3", "t4"]);
  assert.equal(analysis.considered, 5);
  // Only the four failing trajectories are accounted for in a group.
  assert.equal(analysis.observed, 4);

  // Ordering is deterministic: more frequent first, then by signature.
  const ordered = findRecurringFailures({ trajectories: [
    failing("t1", "a", ["x"], 1), failing("t2", "b", ["x"], 2), failing("t3", "c", ["x"], 3),
    failing("t4", "a", ["y"], 4), failing("t5", "b", ["y"], 5),
  ] }).candidates as JsonObject[];
  assert.deepEqual(ordered.map((item) => item.signature), ["x", "y"]);
});

test("v0.12.37 rejects evidence that could fake recurrence", () => {
  const replayed = { trajectories: [failing("t1", "task-a", ["tests"]), failing("t1", "task-b", ["tests"])] };
  // One run reported twice is the most dangerous way to fool this function.
  assert.throws(() => findRecurringFailures(replayed), /must reference distinct traces/u);
  assert.throws(() => findRecurringFailures({ trajectories: "nope" }), /trajectories must be an array/u);
  assert.throws(() => findRecurringFailures({ trajectories: ["nope"] }), /must be an object/u);
  assert.throws(() => findRecurringFailures({ trajectories: [[]] }), /must be an object/u);
  assert.throws(() => findRecurringFailures({ trajectories: [{ task_id: "t", failed_checks: [] }] }), /trace_id must not be empty/u);
  assert.throws(() => findRecurringFailures({ trajectories: [{ trace_id: "t", failed_checks: [] }] }), /task_id must not be empty/u);
  assert.throws(() => findRecurringFailures({ trajectories: [{ trace_id: "t", task_id: "k", outcome: "maybe" }] }), /outcome is unsupported/u);
  assert.throws(() => findRecurringFailures({ trajectories: [{ trace_id: "t", task_id: "k", outcome: "failed", observed_at: "x" }] }), /observed_at must be a number/u);
  assert.throws(() => findRecurringFailures({ trajectories: [{ trace_id: "t", task_id: "k", outcome: "failed", failure_signature: "" }] }), /failure_signature must not be empty/u);
  assert.throws(() => findRecurringFailures({ trajectories: [{ trace_id: "t", task_id: "k", outcome: "failed", failed_checks: [7] }] }), /failed_checks must not be empty/u);
});

test("v0.12.37 builds an abstraction that cannot overclaim", () => {
  const trajectories = [failing("t1", "task-a", ["tests"], 1), failing("t2", "task-b", ["tests"], 2)];
  const abstraction = buildAbstraction({ trajectories, signature: "tests", scope: "project" });
  assert.equal(abstraction.kind, "recurring_failure");
  assert.equal(abstraction.confidence, "moderate");
  // The statement is generated from the evidence, so it names the real counts.
  assert.equal(abstraction.statement, "tests failed across 2 independent trajectories spanning 2 task(s)");
  assert.deepEqual(abstraction.failed_checks, ["tests"]);
  assert.match(String(abstraction.abstraction_id), /^abstraction_[0-9a-f]{24}$/u);
  // Generalising is a claim about the future, so it is proposed, never asserted.
  assert.equal(abstraction.requires_review, true);
  assert.equal(abstraction.execution_authority, false);
  const evidence = abstraction.evidence as JsonObject;
  assert.deepEqual(evidence.trace_ids, ["t1", "t2"]);
  assert.equal(evidence.occurrences, 2);
  assert.equal(evidence.source, "cross_trajectory_abstraction");

  // More independent tasks raise confidence, but never remove the review gate.
  const wide = buildAbstraction({ trajectories: [failing("t1", "a", ["lint"], 1), failing("t2", "b", ["lint"], 2), failing("t3", "c", ["lint"], 3)], signature: "lint" });
  assert.equal(wide.confidence, "high");
  assert.equal(wide.requires_review, true);
  assert.equal(wide.scope, "project");

  // An explicit signature with no check names still generalises, but the
  // statement must not invent names it was never given.
  const unnamed = buildAbstraction({
    trajectories: [
      { trace_id: "t1", task_id: "task-a", outcome: "failed", failure_signature: "sig-x", observed_at: 1 },
      { trace_id: "t2", task_id: "task-b", outcome: "failed", failure_signature: "sig-x", observed_at: 2 },
    ],
    signature: "sig-x",
  });
  assert.equal(unnamed.statement, "An unnamed failure recurred across 2 independent trajectories");
  assert.deepEqual(unnamed.failed_checks, []);

  // The id is stable for the same evidence, so re-running is idempotent.
  assert.equal(buildAbstraction({ trajectories, signature: "tests" }).abstraction_id, abstraction.abstraction_id);
  // An explicit signature that the evidence does not support is refused.
  assert.throws(() => buildAbstraction({ trajectories, signature: "lint" }), /No trajectories exhibit that failure signature/u);
});

test("v0.12.37 runs the whole pass and reports what it nearly found", () => {
  const report = abstractAcrossTrajectories({ trajectories: [
    failing("t1", "task-a", ["tests"], 1),
    failing("t2", "task-b", ["tests"], 2),
    // Recurrence confined to one task: reported, not published.
    failing("t3", "task-c", ["lint"], 3),
    failing("t4", "task-c", ["lint"], 4),
  ], scope: "workspace" });
  assert.equal(report.abstraction_count, 1);
  assert.equal(report.sufficient_evidence, true);
  const abstractions = report.abstractions as JsonObject[];
  assert.equal(abstractions[0]!.signature, "tests");
  assert.equal(abstractions[0]!.scope, "workspace");
  // The near-miss is visible, so abstention is checkable rather than trusted.
  assert.deepEqual(report.rejected, [{ signature: "lint", reason: "single_task_recurrence", occurrences: 2, distinct_tasks: 1 }]);
  assert.equal(report.considered, 4);

  // Silence is distinguishable from "nothing was examined".
  const none = abstractAcrossTrajectories({ trajectories: [] });
  assert.deepEqual(none.abstractions, []);
  assert.equal(none.sufficient_evidence, false);
  assert.equal(none.considered, 0);
});

test("v0.12.37 is reachable from the loop and from MCP", async (t) => {
  // The read/observe half must be mountable by the loop, or the wiring gap is
  // reproduced. `craft_abstraction_build` is deliberately NOT: minting an
  // abstraction is a claim about the future that needs review, so it belongs in
  // the governed tier where the loop cannot self-authorize it.
  const mounted = new Set(DEFAULT_INTERNAL_AUTHORIZATION);
  assert.equal(classifyTool("craft_trajectory_signature_get"), "read");
  assert.equal(classifyTool("craft_abstraction_evaluate"), "read");
  assert.equal(classifyTool("craft_abstraction_build"), "governed");
  assert.equal(mounted.has("governed"), false);
  for (const name of ["craft_trajectory_signature_get", "craft_abstraction_evaluate"]) {
    assert.equal(mounted.has(classifyTool(name)), true, `${name} is not in a mounted tier`);
    assert.equal(authorizedTools(TOOLS, DEFAULT_INTERNAL_AUTHORIZATION).some((tool) => tool.name === name), true, `${name} missing from the projection`);
  }

  const root = join(tmpdir(), `craft-v01237-mcp-${process.pid}-${Date.now()}`);
  await mkdir(root, { recursive: true });
  const store = await new CraftStore(craftPaths(root)).open();
  t.after(async () => { store.close(); await rm(root, { recursive: true, force: true }); });
  const server = new McpServer(new CraftService(store));

  const call = async (name: string, args: JsonObject): Promise<JsonObject> => {
    const response = await server.handle({ id: 1, method: "tools/call", params: { name, arguments: args } });
    assert.equal(response?.error, undefined, `tool ${name} errored: ${JSON.stringify(response?.error)}`);
    const content = (response?.result as JsonObject).content as Array<{ text: string }>;
    return JSON.parse(content[0]!.text) as JsonObject;
  };

  const listed = ((await server.handle({ id: 1, method: "tools/list" }))?.result as JsonObject).tools as JsonObject[];
  for (const name of ["craft_trajectory_signature_get", "craft_abstraction_evaluate", "craft_abstraction_build"]) {
    assert.equal(listed.some((tool) => tool.name === name), true, `${name} is not advertised`);
  }

  const signature = await call("craft_trajectory_signature_get", { failed_checks: ["b", "a"] });
  assert.equal(signature.signature, "a|b");
  assert.deepEqual(signature.failed_checks, ["a", "b"]);
  const trajectories = [failing("t1", "task-a", ["tests"], 1), failing("t2", "task-b", ["tests"], 2)];
  const evaluated = await call("craft_abstraction_evaluate", { trajectories });
  assert.equal(evaluated.abstraction_count, 1);
  const built = await call("craft_abstraction_build", { trajectories, signature: "tests" });
  assert.equal(built.requires_review, true);
  assert.equal(built.execution_authority, false);
});
