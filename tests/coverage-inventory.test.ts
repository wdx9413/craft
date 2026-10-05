import assert from "node:assert/strict";
import test from "node:test";
import { coverageInventory } from "../scripts/coverage/coverage-inventory.ts";

test("coverage inventory exposes omitted production files independently of green groups", () => {
  const result = coverageInventory(["core/known.ts", "core/new.ts", "core/known.ts", "core/types.d.ts", "tests/test.ts", "core/data.json", "adapters/dist/generated.js", "adapters/node_modules/vendor.js", "workbench/page.js"], [{ name: "known", include: ["core/known.ts"] }]);
  assert.equal(result.status, "incomplete");
  assert.deepEqual(result.managed, ["core/known.ts"]);
  assert.deepEqual(result.missing, ["core/new.ts", "workbench/page.js"]);
  assert.equal(result.coverage_proven, false);
  assert.equal(result.native_coverage, "separate_required");
  assert.equal(coverageInventory(["core/known.ts"], [{ name: "known", include: ["core/known.ts"] }]).status, "complete");
  const shared = coverageInventory(["common/craft-common-log/src/index.ts", "common/craft-common-log/src/new.ts", "common/craft-common-log/dist/index.js"], [{ name: "log", include: ["common/craft-common-log/src/*.ts"] }]);
  assert.equal(shared.status, "complete");
  assert.deepEqual(shared.managed, ["common/craft-common-log/src/index.ts", "common/craft-common-log/src/new.ts"]);
  const debt = coverageInventory(["core/old.ts", "core/new.ts"], [], ["core/old.ts"]);
  assert.deepEqual(debt.baseline_missing, ["core/old.ts"]);
  assert.deepEqual(debt.new_missing, ["core/new.ts"]);
  assert.equal(debt.status, "incomplete");
});
