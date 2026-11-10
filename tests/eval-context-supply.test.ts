import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_SUPPLY_AID_LIMIT, CONTEXT_SUPPLY_FACT, CONTEXT_SUPPLY_MARKER, evalCases,
  contextSupplyAidedPrompt, contextSupplyControlPrompt,
  MEMORY_SUPPLY_FACT, MEMORY_SUPPLY_MARKER, memorySupplyAidedPrompt, memorySupplyControlPrompt,
  PROACTIVE_SCENARIOS, proactivePrompt,
} from "../core/eval-cases.ts";
import { LEDGER_MIN_OBSERVATIONS, LEDGERS } from "../core/eval-suite.ts";

const control = contextSupplyControlPrompt();
const aided = contextSupplyAidedPrompt(CONTEXT_SUPPLY_FACT);

test("the value ledger holds only paired benefit cases, and every one observes the model", () => {
  const value = evalCases().filter((entry) => entry.case.ledger === "value");
  assert.equal(value.length, 6);
  assert.deepEqual([...new Set(value.map((entry) => entry.case.evidence))], ["model_output"]);
  assert.deepEqual([...new Set(value.map((entry) => entry.case.axis))].sort(), ["context_supply", "proactive_restraint"]);
  for (const entry of value) {
    assert.equal(entry.case.partition, "held_out");
    assert.ok(["contains", "equals"].includes(entry.check.kind));
    assert.ok(entry.prompt && entry.prompt.length > 0, `${entry.case.id} needs a prompt to send`);
  }
  // The two context-supply scenarios use two independent markers: a shared
  // marker would let one lucky answer carry both cases.
  const contextSupply = value.filter((entry) => entry.case.axis === "context_supply");
  assert.equal(new Set(contextSupply.map((entry) => entry.check.expected)).size, 2);
});

test("the aided turn differs from the control turn by exactly the supplied context", () => {
  // The two turns share the same question and the same uncertainty clause, so a
  // difference in outcome can only be credited to the context Craft supplied.
  assert.ok(aided.endsWith(control), "the aided turn keeps the control text verbatim");
  const aid = aided.slice(0, aided.length - control.length);
  assert.ok(aid.includes(CONTEXT_SUPPLY_FACT));
  assert.ok(aid.includes("bounded"));
  assert.equal(Buffer.byteLength(aid, "utf8"), Buffer.byteLength(aided, "utf8") - Buffer.byteLength(control, "utf8"));
});

test("the aid is inside the documented budget and the control carries no answer", () => {
  assert.ok(aided.length - control.length <= CONTEXT_SUPPLY_AID_LIMIT,
    `aid must fit the budget, saw ${aided.length - control.length}`);
  assert.equal(control.includes(CONTEXT_SUPPLY_MARKER), false,
    "the control must not contain the fact it is meant to prove unavailable");
  assert.equal(evalCases().some((entry) => entry.case.id.startsWith("value.")), false,
    "case ids stay namespaced by axis, so a value-ledger case cannot hide under a fake prefix");
});

test("the Memory scenario keeps the same paired shape and an honest budget", () => {
  const memoryControl = memorySupplyControlPrompt();
  const memoryAided = memorySupplyAidedPrompt(MEMORY_SUPPLY_FACT);
  // Same rule as the first scenario: the only difference is the supplied aid,
  // so a pass is attributable to Memory rather than to a reworded question.
  assert.ok(memoryAided.endsWith(memoryControl), "the aided turn keeps the control text verbatim");
  assert.ok(memoryAided.includes("Craft Memory"), "the aided turn says where the aid came from");
  assert.ok(memoryAided.length - memoryControl.length <= CONTEXT_SUPPLY_AID_LIMIT,
    `memory aid must fit the budget, saw ${memoryAided.length - memoryControl.length}`);
  assert.equal(memoryControl.includes(MEMORY_SUPPLY_MARKER), false,
    "the control must not contain the rule it is meant to prove unavailable");
  // The two scenarios cannot be satisfied by the same token.
  assert.notEqual(MEMORY_SUPPLY_MARKER, CONTEXT_SUPPLY_MARKER);
  assert.equal(MEMORY_SUPPLY_FACT.includes(MEMORY_SUPPLY_MARKER), true);
});

test("the declared minimums cannot be quietly lowered to zero", () => {
  // This is the anti-overclaim invariant: an observation is not a headline.
  // The bar is declared once, in the ledger definition, and must stay positive
  // for every ledger; a run with one observation per ledger stays unquotable.
  for (const ledger of LEDGERS) {
    assert.ok(Number.isInteger(LEDGER_MIN_OBSERVATIONS[ledger]), `${ledger} needs a declared integer minimum`);
    assert.ok(LEDGER_MIN_OBSERVATIONS[ledger] >= 1, `${ledger} minimum must not be zero`);
  }
  assert.ok(LEDGER_MIN_OBSERVATIONS.value >= 2, "value must require more than a single lucky turn");
  assert.ok(LEDGER_MIN_OBSERVATIONS.capability >= LEDGER_MIN_OBSERVATIONS.value,
    "the deterministic ledger has the largest case set and the highest bar");
});

test("the proactive pair contains a positive case and hard counterexamples", () => {
  // NEEDREAD §13.3: a positive case paired with "should not act" counterexamples.
  // The set is fixed here so a suite that only ever stays silent, or only ever
  // nudges, cannot be assembled from a single direction.
  assert.equal(PROACTIVE_SCENARIOS.length, 4);
  const positive = PROACTIVE_SCENARIOS.filter((scenario) => scenario.expected === "act");
  const negative = PROACTIVE_SCENARIOS.filter((scenario) => scenario.expected === "skip");
  assert.equal(positive.length, 1, "one genuinely open item must be actionable");
  assert.ok(negative.length >= 3, "the counterexamples must cover handled, refused, stale and changed-goal shapes");
  for (const keyword of ["already", "do-not-disturb", "older than its validity window", "superseded"]) {
    assert.ok(PROACTIVE_SCENARIOS.some((scenario) => scenario.situation.includes(keyword)),
      `missing counterexample shape: ${keyword}`);
  }
  // One decision contract for every scenario, so the only difference is the
  // situation rather than a reworded instruction.
  const prompts = PROACTIVE_SCENARIOS.map(proactivePrompt);
  assert.equal(new Set(prompts.map((prompt) => prompt.slice(prompt.indexOf("Reply with exactly one word")))).size, 1);
  assert.equal(new Set(PROACTIVE_SCENARIOS.map((scenario) => scenario.id)).size, 4);
});
