import assert from "node:assert/strict";
import test from "node:test";
import { CONCEPTS, CONCEPT_KINDS, isConceptKind } from "craft-common-ontology";
import { mapLegacyKind, validateConcept } from "craft-common-ontology/validation";

test("the taxonomy defines exactly the six shared concept kinds with a test and a counter-example", () => {
  assert.deepEqual([...CONCEPT_KINDS], ["fact", "rule", "decision", "term", "preference", "procedure"]);
  for (const kind of CONCEPT_KINDS) {
    const definition = CONCEPTS[kind];
    assert.ok(definition.is.length > 20, `${kind} needs a definition`);
    assert.ok(definition.test.length > 20, `${kind} needs a one-line test`);
    assert.ok(definition.not.length > 20, `${kind} needs a counter-example`);
    assert.ok(isConceptKind(kind));
  }
  assert.equal(isConceptKind("failure_mode"), false);
});

test("a clean statement is accepted and whitespace-normalised", () => {
  assert.deepEqual(validateConcept("rule", "  Use pnpm,   not npm, for this monorepo.  "),
    { kind: "rule", statement: "Use pnpm, not npm, for this monorepo." });
});

test("unknown kinds, empty statements and prose dumps are rejected", () => {
  assert.throws(() => validateConcept("failure_mode", "x"), /concept kind must be one of/u);
  assert.throws(() => validateConcept("fact", "   "), /non-empty/u);
  assert.throws(() => validateConcept("fact", "a".repeat(301)), /300 characters or fewer/u);
});

test("filler phrases and context-dependent statements are rejected so records stand alone", () => {
  assert.throws(() => validateConcept("fact", "相关内容待补充"), /filler phrase/u);
  assert.throws(() => validateConcept("fact", "见上文"), /filler phrase/u);
  assert.throws(() => validateConcept("decision", "同上"), /filler phrase/u);
  assert.throws(() => validateConcept("fact", "以上都适用"), /stand on its own/u);
});

test("legacy component kinds map onto the shared taxonomy and unknown ones fail closed", () => {
  assert.equal(mapLegacyKind("knowledge", "failure_mode"), "rule");
  assert.equal(mapLegacyKind("memory", "procedural"), "procedure");
  assert.equal(mapLegacyKind("experience", "scenario"), "procedure");
  assert.throws(() => mapLegacyKind("memory", "made_up"), /unsupported memory kind/u);
});
