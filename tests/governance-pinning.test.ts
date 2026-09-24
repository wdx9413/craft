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
  compactionPlan, constraintChannelRisk, defineConstraint, detectConstraintDecay,
  estimateTokens, pinConstraints, verifyPinIntact
} from "../core/governance-pinning.ts";

const constraint = (id: string, effect = "external_write"): JsonObject =>
  ({ id, kind: "prohibited_effect", statement: `Never ${effect} outside the company domain`, effect, scope: "company" });

test("v0.12.40 renders a deterministic pin block", () => {
  const block = pinConstraints([constraint("no-external-email"), constraint("no-prod-drop", "destructive")]);
  // Sorted by id, so two callers listing the same rules in different orders get
  // the same digest — otherwise a re-ordered list would look like a policy change.
  const reordered = pinConstraints([constraint("no-prod-drop", "destructive"), constraint("no-external-email")]);
  assert.equal(block.pinned_digest, reordered.pinned_digest);
  assert.deepEqual(block.constraint_ids, ["no-external-email", "no-prod-drop"]);
  assert.match(String(block.pinned_digest), /^sha256:[0-9a-f]{64}$/u);
  assert.match(block.text, /no-external-email/u);
  assert.equal(block.tokens, estimateTokens(block.text));

  assert.throws(() => pinConstraints([]), /must be a non-empty array/u);
  assert.throws(() => pinConstraints([1 as unknown as JsonObject]), /must be an object/u);
  assert.throws(() => pinConstraints([[] as unknown as JsonObject]), /must be an object/u);
  assert.throws(() => pinConstraints([constraint("a"), constraint("a")]), /ids must be unique/u);
  assert.throws(() => defineConstraint({ id: "x", kind: "maybe", statement: "s", effect: "e" }), /kind is unsupported/u);
  assert.throws(() => defineConstraint({ kind: "prohibited_effect", statement: "s", effect: "e" }), /id must not be empty/u);
  assert.throws(() => defineConstraint({ id: "x", kind: "prohibited_effect", effect: "e" }), /statement must not be empty/u);
  assert.throws(() => defineConstraint({ id: "x", kind: "prohibited_effect", statement: "s" }), /effect must not be empty/u);
  // A scope is optional and defaults to every scope.
  assert.equal(defineConstraint({ id: "x", kind: "prohibited_effect", statement: "s", effect: "e" }).scope, "*");
});

test("v0.12.40 takes constraints out of the eviction competition", () => {
  // The whole defence: a constraint is NOT ranked against task state. Here the
  // budget fits one small segment, and the constraint is far larger than it.
  const plan = compactionPlan({
    constraints: [constraint("no-external-email")],
    max_tokens: 10,
    segments: [
      { id: "no-external-email", content: "Never send email outside the company domain, ever", weight: 1, tokens: 900 },
      { id: "task-state", content: "auditing the billing module", weight: 99, tokens: 8 },
      { id: "tool-output", content: "irrelevant volume", weight: 1, tokens: 500 },
    ],
  });
  // Ranked by weight the constraint would be evicted first; here it is untouchable.
  assert.deepEqual(plan.pinned, ["no-external-email"]);
  assert.deepEqual(plan.kept, ["task-state"]);
  assert.deepEqual(plan.omitted, ["tool-output"]);
  assert.equal(plan.constraints_preserved, true);
  // Pinning is not free, and the cost is reported rather than hidden.
  assert.equal(plan.total_tokens, Number(plan.tokens) + Number(plan.pinned_tokens));
  assert.ok(Number(plan.pinned_tokens) > 0);

  // Even a budget of one token cannot drop it, because it never enters the loop.
  const tight = compactionPlan({
    constraints: [constraint("no-external-email")],
    max_tokens: 1,
    segments: [{ id: "no-external-email", content: "rule", weight: 5, tokens: 900 }, { id: "big", content: "x", weight: 9, tokens: 100 }],
  });
  assert.deepEqual(tight.kept, []);
  assert.deepEqual(tight.pinned, ["no-external-email"]);
  assert.equal(tight.constraints_preserved, true);
});

test("v0.12.40 never silently protects an undeclared rule", () => {
  // `declared-rule` is a real constraint that has no matching segment in the
  // context, so it is reported as unbound rather than quietly treated as
  // satisfied. `undeclared-rule` is a segment that LOOKS like a constraint but
  // was never defined, so it must stay evictable instead of being auto-pinned:
  // auto-pinning it would protect a policy nobody declared.
  const plan = compactionPlan({
    constraints: [constraint("declared-rule")],
    max_tokens: 100,
    segments: [{ id: "undeclared-rule", content: "some rule", weight: 1, tokens: 10 }],
  });
  assert.deepEqual(plan.pinned, ["declared-rule"]);
  assert.deepEqual(plan.unbound_constraints, ["declared-rule"]);
  assert.equal(plan.constraints_preserved, false);
  // The undeclared segment stays evictable, which is the honest treatment.
  assert.deepEqual(plan.kept, ["undeclared-rule"]);
});

test("v0.12.40 defaults what the caller left out instead of failing", () => {
  // A segment with no weight defaults to 1 and no tokens is estimated from its
  // content, so a caller supplying raw text is not forced to pre-compute both.
  const plan = compactionPlan({
    constraints: [constraint("c")],
    max_tokens: 50,
    segments: [
      { id: "plain", content: "short task state" },
      { id: "other", content: "another segment" },
    ],
  });
  // Equal default weights fall back to insertion order, which is deterministic.
  assert.deepEqual(plan.kept, ["plain", "other"]);
  assert.ok(Number(plan.tokens) > 0);

  // An explicit weight still wins over the default when the budget forces a
  // choice. Each 4-char segment estimates to 1 token, so a 1-token budget keeps
  // exactly the heavier one.
  const weighted = compactionPlan({
    constraints: [constraint("c")],
    max_tokens: 1,
    segments: [{ id: "low", content: "aaaa", weight: 1 }, { id: "high", content: "bbbb", weight: 9 }],
  });
  assert.deepEqual(weighted.kept, ["high"]);
  assert.deepEqual(weighted.omitted, ["low"]);

  // A segment with neither tokens nor content still projects deterministically
  // rather than throwing on arithmetic over undefined.
  const barren = compactionPlan({
    constraints: [constraint("c")],
    max_tokens: 10,
    segments: [{ id: "empty-segment" }],
  });
  assert.deepEqual(barren.kept, ["empty-segment"]);
  assert.equal(barren.tokens, 1);

  // Omitting `constraints` entirely is a configuration error, not an empty pin.
  assert.throws(() => compactionPlan({ max_tokens: 10, segments: [] }), /constraints must be a non-empty array/u);
  assert.throws(() => verifyPinIntact({ rendered: "x" }), /constraints must be a non-empty array/u);
  // `kind` is validated first, so an empty input names that field.
  assert.throws(() => defineConstraint({}), /kind must not be empty/u);
});

test("v0.12.40 rejects unusable compaction inputs", () => {
  const base = { constraints: [constraint("c")], segments: [] };
  assert.throws(() => compactionPlan({ ...base, max_tokens: 10, segments: "nope" }), /segments must be an array/u);
  assert.throws(() => compactionPlan({ ...base, max_tokens: 0 }), /max_tokens must be a positive integer/u);
  assert.throws(() => compactionPlan({ ...base, max_tokens: 1.5 }), /max_tokens must be a positive integer/u);
  assert.throws(() => compactionPlan({ ...base, max_tokens: "10" }), /max_tokens must be a positive integer/u);
  assert.throws(() => compactionPlan({ ...base, max_tokens: 10, segments: [1] }), /segments\[0\] must be an object/u);
  assert.throws(() => compactionPlan({ ...base, max_tokens: 10, segments: [{}] }), /id must not be empty/u);
  assert.throws(() => compactionPlan({ max_tokens: 10, segments: [] }), /constraints must be a non-empty array/u);
});

test("v0.12.40 verifies integrity by content, not by presence", () => {
  const block = pinConstraints([constraint("no-external-email")]);
  const intact = verifyPinIntact({ constraints: [constraint("no-external-email")], rendered: block.text });
  assert.equal(intact.intact, true);
  assert.equal(intact.verdict, "preserved");
  assert.deepEqual(intact.missing, []);

  // The rule left entirely — the decay case.
  const dropped = verifyPinIntact({ constraints: [constraint("no-external-email")], rendered: "just task state" });
  assert.equal(dropped.intact, false);
  assert.equal(dropped.verdict, "dropped");
  assert.deepEqual(dropped.missing, ["no-external-email"]);

  // Id present but the rule reworded: passing this would mean the digest lies.
  const reworded = verifyPinIntact({
    constraints: [constraint("no-external-email")],
    rendered: "no-external-email: never mail out",
  });
  assert.equal(reworded.intact, false);
  assert.equal(reworded.verdict, "reworded");
  assert.deepEqual(reworded.reworded, ["no-external-email"]);

  assert.throws(() => verifyPinIntact({ constraints: [constraint("c")], rendered: 1 }), /rendered must be a string/u);
  assert.throws(() => verifyPinIntact({ rendered: "x" }), /constraints must be a non-empty array/u);
});

test("v0.12.40 attributes decay to the constraint only when it caused it", () => {
  // The measurement from the paper: same request, same model, only context differs.
  const decay = detectConstraintDecay({ violated_before_compaction: false, violated_after_compaction: true, constraint_dropped: true });
  assert.equal(decay.decay_detected, true);
  assert.equal(decay.attributable_to_pinning, true);
  assert.match(String(decay.explanation), /constraint left the context/u);

  // A violation that appeared without the constraint being dropped is a
  // DIFFERENT finding, and claiming pinning would fix it would overstate it.
  const other = detectConstraintDecay({ violated_before_compaction: false, violated_after_compaction: true, constraint_dropped: false });
  assert.equal(other.decay_detected, true);
  assert.equal(other.attributable_to_pinning, false);
  assert.match(String(other.explanation), /look elsewhere/u);

  // Already violating: compaction is not the cause.
  assert.equal(detectConstraintDecay({ violated_before_compaction: true, violated_after_compaction: true, constraint_dropped: true }).decay_detected, false);
  // No violation at all.
  const clean = detectConstraintDecay({ violated_before_compaction: false, violated_after_compaction: false, constraint_dropped: false });
  assert.equal(clean.decay_detected, false);
  assert.match(String(clean.explanation), /no violation in either condition/u);

  assert.throws(() => detectConstraintDecay({ violated_before_compaction: "no", violated_after_compaction: true, constraint_dropped: true }), /must be booleans/u);
  assert.throws(() => detectConstraintDecay({ violated_before_compaction: false, violated_after_compaction: true, constraint_dropped: "yes" }), /constraint_dropped must be a boolean/u);
});

test("v0.12.40 reports which channel a constraint travels on", () => {
  // Craft has no system channel, so its governance lives on the compacted ones.
  const risk = constraintChannelRisk({ channels: ["memory", "tool_output"] });
  assert.equal(risk.exposure, 78);
  assert.deepEqual(risk.vulnerable, ["memory", "tool_output"]);
  assert.match(String(risk.recommendation), /pin the constraint/u);

  // The one channel that does not decay.
  const safe = constraintChannelRisk({ channels: ["system"] });
  assert.equal(safe.exposure, 0);
  assert.deepEqual(safe.vulnerable, []);
  assert.match(String(safe.recommendation), /no compacted channel/u);

  assert.throws(() => constraintChannelRisk({ channels: ["carrier_pigeon"] }), /channel is unsupported/u);
  assert.throws(() => constraintChannelRisk({ channels: [] }), /must be a non-empty array/u);
  assert.throws(() => constraintChannelRisk({ channels: [""] }), /must not be empty/u);
  assert.throws(() => constraintChannelRisk({}), /must be a non-empty array/u);
});

test("v0.12.40 exposes the read half to the loop and keeps pinning governed", async (t) => {
  // The asymmetry is the point: the loop must be able to CHECK its guardrail,
  // but must not be able to REDEFINE one.
  const mounted = new Set(DEFAULT_INTERNAL_AUTHORIZATION);
  assert.equal(classifyTool("craft_governance_pin_get"), "read");
  assert.equal(classifyTool("craft_governance_pin_check"), "read");
  assert.equal(classifyTool("craft_governance_compaction_evaluate"), "read");
  assert.equal(classifyTool("craft_governance_constraint_define"), "governed");
  assert.equal(mounted.has("governed"), false);
  for (const name of ["craft_governance_pin_get", "craft_governance_pin_check", "craft_governance_compaction_evaluate"]) {
    assert.equal(mounted.has(classifyTool(name)), true, `${name} is not in a mounted tier`);
    assert.equal(authorizedTools(TOOLS, DEFAULT_INTERNAL_AUTHORIZATION).some((tool) => tool.name === name), true, `${name} missing from the projection`);
  }

  const root = join(tmpdir(), `craft-v01240-mcp-${process.pid}-${Date.now()}`);
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
  for (const name of ["craft_governance_pin_get", "craft_governance_pin_check", "craft_governance_compaction_evaluate", "craft_governance_constraint_define"]) {
    assert.equal(listed.some((tool) => tool.name === name), true, `${name} is not advertised`);
  }

  const block = await call("craft_governance_pin_get", { constraints: [constraint("no-external-email")] });
  assert.equal(block.pinned_digest, pinConstraints([constraint("no-external-email")]).pinned_digest);

  const checked = await call("craft_governance_pin_check", { constraints: [constraint("no-external-email")], rendered: block.text as string });
  assert.equal(checked.intact, true);

  const planned = await call("craft_governance_compaction_evaluate", {
    constraints: [constraint("no-external-email")], max_tokens: 10,
    segments: [{ id: "no-external-email", content: "rule", weight: 1, tokens: 900 }, { id: "t", content: "x", weight: 9, tokens: 8 }],
  });
  assert.deepEqual(planned.pinned, ["no-external-email"]);
  assert.equal(planned.constraints_preserved, true);
});
