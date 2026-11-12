import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "../core/infrastructure/store.ts";
import { relationDiagnosticsSummary } from '@craft/capability-codebase/codebase-index';

const combined = {
  languages: [
    { analyzer: "typescript-checker", diagnostics: {
      unresolved_relations: 218, unresolved_type_references: 0, unresolved_heritage: 0,
      unresolved_imports: 0, unresolved_calls: 218, external_references: 124863,
      local_type_parameters: 112, computed_invocations: 128, inline_invocations: 47,
      omitted_nodes: 0, omitted_edges: 0, budget_limited: false,
      unresolved_call_samples: ["run", "digest"], unresolved_type_reference_samples: [],
    } },
    { analyzer: "shell-static", diagnostics: { relations: "analyzed", analyzed_files: 4, unresolved_relations: 0 } },
  ],
  degraded_languages: [
    { language: "yaml", status: "unavailable", reason: "unsupported_lsp_language" },
    { language: "java", status: "unavailable", reason: "jdk_unavailable", detail: "no jdk" },
  ],
  omitted_nodes: 0, omitted_edges: 0, budget_limited: false,
};

test("relation diagnostics separate external references from internal gaps", () => {
  const summary = relationDiagnosticsSummary([combined]) as JsonObject;
  assert.equal(summary.unresolved_relations, 218);
  assert.equal(summary.unresolved_type_references, 0);
  assert.equal(summary.unresolved_calls, 218);
  assert.equal(summary.external_references, 124863);
  assert.equal(summary.local_type_parameters, 112);
  assert.equal(summary.computed_invocations, 128);
  assert.equal(summary.inline_invocations, 47);
  assert.deepEqual(summary.unresolved_call_samples, ["run", "digest"]);
  assert.deepEqual(summary.analyzers, ["shell-static", "typescript-checker"]);
});

test("degraded languages carry a reason and optional detail", () => {
  const summary = relationDiagnosticsSummary([combined]) as JsonObject;
  const degraded = summary.degraded_languages as JsonObject[];
  assert.deepEqual(degraded.map((item) => [item.language, item.reason]),
    [["java", "jdk_unavailable"], ["yaml", "unsupported_lsp_language"]]);
  assert.equal(degraded[0]!.detail, "no jdk");
});

test("a missing or empty diagnostics tree reports zeroes rather than undefined", () => {
  for (const input of [undefined, null, [], {}]) {
    const summary = relationDiagnosticsSummary(input) as JsonObject;
    assert.equal(summary.unresolved_relations, 0);
    assert.equal(summary.external_references, 0);
    assert.deepEqual(summary.degraded_languages, []);
    assert.deepEqual(summary.analyzers, []);
  }
});
