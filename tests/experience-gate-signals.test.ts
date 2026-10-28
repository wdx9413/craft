import assert from "node:assert/strict";
import test from "node:test";
import { experienceGatePenalty, experienceGatePenaltyFromGates } from "../capability/craft-experience/gate-signals.ts";
import type { CraftStore, JsonObject } from "../common/craft-common-store-local/src/store.ts";

test("gate penalties are neutral for empty ids, clean gates and unrelated procedures", () => {
  assert.equal(experienceGatePenaltyFromGates([], []).size, 0);
  assert.equal(experienceGatePenaltyFromGates([], ["p1"]).get("p1"), 1);
  assert.equal(experienceGatePenaltyFromGates([{ procedure_id: "p1", passed: true }], ["p1"]).get("p1"), 1);
  assert.equal(experienceGatePenaltyFromGates([{ procedure_id: "p1" }], ["p1"]).get("p1"), 1);
  assert.equal(experienceGatePenaltyFromGates([{ procedure_id: "p2", passed: false }], ["p1"]).get("p1"), 1);
});

test("failed gates demote only their own procedure and clamp", () => {
  const gates: JsonObject[] = [
    { procedure_id: "p1", passed: false },
    { procedure_id: "p1", passed: false },
    { procedure_id: "p2", passed: false },
  ];
  const weights = experienceGatePenaltyFromGates(gates, ["p1", "p3"]);
  assert.equal(weights.get("p1"), 0.6);
  assert.equal(weights.get("p3"), 1);
  const many = Array.from({ length: 8 }, () => ({ procedure_id: "p4", passed: false }));
  assert.equal(experienceGatePenaltyFromGates(many, ["p4"]).get("p4"), 0.25);
});

test("the store wrapper reads only failed gates for the requested procedures", () => {
  const rows: JsonObject[] = [{ procedure_id: "p1", passed: false }, { procedure_id: "p2", passed: false }];
  const store = { list: (_kind: string, _limit: number, predicate?: (item: JsonObject) => boolean) =>
    predicate ? rows.filter(predicate) : rows } as unknown as CraftStore;
  assert.equal(experienceGatePenalty(store, ["p1"]).get("p1"), 0.8);
  assert.equal(experienceGatePenalty(store, []).size, 0);
});