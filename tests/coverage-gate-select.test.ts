import assert from "node:assert/strict";
import test from "node:test";
import { parseGroupArguments, selectGateGroups, type SelectableGroup } from "../scripts/coverage/coverage-gate-select.ts";

const groups: SelectableGroup[] = [
  { name: "eval-comparator", include: ["core/eval-suite.ts"], tests: ["t1"] },
  { name: "knowledge-lineage-impact", include: ["capability/craft-knowledge/knowledge-lineage-impact.ts"], tests: ["t2"] },
  { name: "eval-suite", include: ["core/eval-suite.ts", "core/eval-cases.ts"], tests: ["t3"] },
];

test("an empty selector list selects every group in manifest order", () => {
  const result = selectGateGroups(groups, []);
  assert.deepEqual(result.groups.map((group) => group.name), ["eval-comparator", "knowledge-lineage-impact", "eval-suite"]);
  assert.deepEqual(result.unknown, []);
});

test("groups are selectable by name or by an included source path, with Windows separators", () => {
  assert.deepEqual(selectGateGroups(groups, ["eval-comparator"]).groups.map((group) => group.name), ["eval-comparator"]);
  assert.deepEqual(selectGateGroups(groups, ["capability\\craft-knowledge\\knowledge-lineage-impact.ts"]).groups.map((group) => group.name), ["knowledge-lineage-impact"]);
  // Two selectors matching the same group return it once.
  assert.deepEqual(selectGateGroups(groups, ["eval-suite", "core/eval-cases.ts"]).groups.map((group) => group.name), ["eval-suite"]);
});

test("an unknown selector is reported instead of producing a silent empty run", () => {
  const result = selectGateGroups(groups, ["eval-comparator", "no-such-group"]);
  assert.deepEqual(result.groups.map((group) => group.name), ["eval-comparator"]);
  assert.deepEqual(result.unknown, ["no-such-group"]);
});

test("group arguments parse comma lists, equals form, repetition and --list", () => {
  assert.deepEqual(parseGroupArguments(["--group", "a,b", "--group=c"]), { selectors: ["a", "b", "c"], list: false });
  assert.deepEqual(parseGroupArguments(["--list"]), { selectors: [], list: true });
  assert.deepEqual(parseGroupArguments([]), { selectors: [], list: false });
  assert.throws(() => parseGroupArguments(["--group"]), /requires a value/u);
  assert.throws(() => parseGroupArguments(["--group", "--list"]), /requires a value/u);
  assert.throws(() => parseGroupArguments(["--nope"]), /unknown option/u);
});
