import assert from "node:assert/strict";
import test from "node:test";
import { runPairedValueCases } from "craft-eval/paired-value-runs";
import type { EvalTrial } from "craft-eval/model";
import {
  CONTEXT_SUPPLY_MARKER, MEMORY_SUPPLY_FACT, MEMORY_SUPPLY_MARKER, PROACTIVE_SCENARIOS,
  proactivePrompt,
} from "../core/eval-cases.ts";

const PROACTIVE_IDS = PROACTIVE_SCENARIOS.map((scenario) => scenario.id);
const ALL_IDS = [
  "context_supply.supplied_context_replaces_explanation",
  "context_supply.memory_hit_replaces_repetition",
  ...PROACTIVE_IDS,
];

interface Call { prompt: string; reply: string }

function runner(replies: (prompt: string) => string) {
  const calls: Call[] = [];
  let turns = 0;
  return {
    calls,
    get turns() { return turns; },
    value: {
      ask: async (prompt: string) => {
        const reply = replies(prompt);
        calls.push({ prompt, reply });
        return { text: reply, model: "test-model", usage: { input_tokens: 20, output_tokens: 10 },
          elapsed_ms: 1, max_tokens: 1024 } satisfies EvalTrial;
      },
      addTurns: (count: number) => { turns += count; },
      inScope: (id: string) => ALL_IDS.includes(id),
      gap: null,
      memoryAid: async () => ({ text: MEMORY_SUPPLY_FACT, hits: 1 }),
    },
  };
}

/** Reply `skip`/`act` by matching the shared decision contract in the prompt. */
function proactiveReply(prompt: string): string {
  const scenario = PROACTIVE_SCENARIOS.find((item) => proactivePrompt(item) === prompt);
  return scenario ? scenario.expected : "skip";
}

test("a clean paired run passes six cases and accounts for every model turn", async () => {
  const harness = runner((prompt) => {
    if (prompt.includes(CONTEXT_SUPPLY_MARKER)) return `pnpm ${CONTEXT_SUPPLY_MARKER}`;
    if (prompt.includes(MEMORY_SUPPLY_MARKER)) return `release/${MEMORY_SUPPLY_MARKER}`;
    return proactiveReply(prompt);
  });
  const outcomes = await runPairedValueCases(harness.value);
  assert.equal(outcomes.length, 6);
  assert.deepEqual(outcomes.map((item) => [item.id, item.passed]), ALL_IDS.map((id) => [id, true]));
  // Two paired cases × 3 attempts × 2 turns, plus one turn per proactive case.
  assert.equal(harness.turns, 2 * 3 * 2 + PROACTIVE_IDS.length);
  assert.equal(harness.calls.length, harness.turns);
});

test("one baseline leak fails hard even if the aided turns would carry the rule", async () => {
  let baselineCalls = 0;
  const harness = runner((prompt) => {
    if (prompt.includes("Reply with exactly one word")) return proactiveReply(prompt);
    // The first control turn of the first pair leaks the marker.
    if (!prompt.includes(CONTEXT_SUPPLY_MARKER) && !prompt.includes(MEMORY_SUPPLY_MARKER)) {
      baselineCalls += 1;
      if (baselineCalls === 1) return `pnpm ${CONTEXT_SUPPLY_MARKER}`;
      return "unknown";
    }
    return prompt.includes(CONTEXT_SUPPLY_MARKER) ? `pnpm ${CONTEXT_SUPPLY_MARKER}` : `release/${MEMORY_SUPPLY_MARKER}`;
  });
  const outcomes = await runPairedValueCases(harness.value);
  const leaked = outcomes.find((item) => item.id === "context_supply.supplied_context_replaces_explanation")!;
  assert.equal(leaked.passed, false);
  assert.match(leaked.reason, /baseline_leaked=true/u);
});

test("a majority of clean attributions passes despite one model miss", async () => {
  let aidedCount = 0;
  const harness = runner((prompt) => {
    if (prompt.includes("Reply with exactly one word")) return proactiveReply(prompt);
    if (prompt.includes(MEMORY_SUPPLY_MARKER)) return `release/${MEMORY_SUPPLY_MARKER}`;
    if (prompt.includes(CONTEXT_SUPPLY_MARKER)) {
      aidedCount += 1;
      // One of three aided turns misses; the other two carry the rule.
      return aidedCount === 2 ? "unknown" : `pnpm ${CONTEXT_SUPPLY_MARKER}`;
    }
    return "unknown";
  });
  const outcomes = await runPairedValueCases(harness.value);
  const contextCase = outcomes.find((item) => item.id === "context_supply.supplied_context_replaces_explanation")!;
  assert.equal(contextCase.passed, true);
  assert.match(contextCase.reason, /successes=2\/3/u);
});

test("an always-silent or always-nudging policy fails every proactive case", async () => {
  for (const constant of ["skip", "act"]) {
    const harness = runner((prompt) => {
      if (prompt.includes("Reply with exactly one word")) return constant;
      if (prompt.includes(CONTEXT_SUPPLY_MARKER)) return `pnpm ${CONTEXT_SUPPLY_MARKER}`;
      if (prompt.includes(MEMORY_SUPPLY_MARKER)) return `release/${MEMORY_SUPPLY_MARKER}`;
      return "unknown";
    });
    const outcomes = await runPairedValueCases(harness.value);
    for (const id of PROACTIVE_IDS) {
      const outcome = outcomes.find((item) => item.id === id)!;
      assert.equal(outcome.passed, false, `${id} must fail the ${constant}-only policy`);
      assert.match(outcome.reason, /degenerate=true/u);
    }
  }
});

test("a credential gap marks every selected case unobserved, not failed", async () => {
  const harness = runner(() => "unreachable");
  const outcomes = await runPairedValueCases({ ...harness.value, gap: "OPENAI_API_KEY is not set" });
  assert.equal(outcomes.length, 6);
  assert.ok(outcomes.every((item) => item.passed === null && item.reason.includes("OPENAI_API_KEY")));
  assert.equal(harness.turns, 0, "no model turn is made when credentials are missing");
});

test("a missing Memory kernel marks only the Memory case unobserved", async () => {
  const harness = runner((prompt) => {
    if (prompt.includes("Reply with exactly one word")) return proactiveReply(prompt);
    if (prompt.includes(CONTEXT_SUPPLY_MARKER)) return `pnpm ${CONTEXT_SUPPLY_MARKER}`;
    return "unknown";
  });
  const outcomes = await runPairedValueCases({ ...harness.value, memoryAid: null });
  const memoryCase = outcomes.find((item) => item.id === "context_supply.memory_hit_replaces_repetition")!;
  assert.equal(memoryCase.passed, null);
  assert.match(memoryCase.reason, /Memory kernel is unavailable/u);
  assert.equal(outcomes.filter((item) => item.passed === true).length, 5);
});
