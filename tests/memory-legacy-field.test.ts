import assert from "node:assert/strict";
import test from "node:test";
import { legacyFieldAbsent } from '@craft/capability-memory/memory-legacy-field';
import type { CraftStore, JsonObject } from 'craft-common-store-local/store';

const storeWithHistory = (rows: JsonObject[]): CraftStore =>
  ({ history: () => rows }) as unknown as CraftStore;

test("a legacy field is absent only when the complete bounded history agrees", () => {
  const store = storeWithHistory([{ version: 1 }]);
  assert.equal(legacyFieldAbsent(store, "memory_item", { id: "m1", version: 1 }, "scope"), true);
  assert.equal(legacyFieldAbsent(storeWithHistory([{ version: 1 }, { version: 2 }]), "memory_item", { id: "m1", version: 3 }, "scope"), true);
  assert.equal(legacyFieldAbsent(storeWithHistory([{ version: 1 }, { version: 2, scope: "project" }]), "memory_item", { id: "m1", version: 3 }, "scope"), false);
  assert.equal(legacyFieldAbsent(storeWithHistory([{ version: 1 }]), "memory_item", { id: "m1", version: 3 }, "scope"), false);
});

test("invalid identity, first-version records and excessive versions are decided without history", () => {
  const store = storeWithHistory([]);
  const calls: Array<[string, string, number, number]> = [];
  const spy = { history: (...args: [string, string, number, number]) => { calls.push(args); return [] as JsonObject[]; } } as unknown as CraftStore;
  assert.equal(legacyFieldAbsent(spy, "kind", {}, "scope"), false);
  assert.equal(legacyFieldAbsent(spy, "kind", { id: "", version: 2 }, "scope"), false);
  assert.equal(legacyFieldAbsent(spy, "kind", { id: "id", version: 1.5 }, "scope"), false);
  assert.equal(legacyFieldAbsent(spy, "kind", { id: "id", version: 0 }, "scope"), false);
  assert.equal(legacyFieldAbsent(spy, "kind", { id: "id", version: 1 }, "scope"), true);
  assert.equal(legacyFieldAbsent(spy, "kind", { id: "id", version: 103 }, "scope"), false);
  assert.equal(legacyFieldAbsent(store, "kind", { id: "id", version: 2 }, "scope"), false);
  assert.deepEqual(calls, []);
});
