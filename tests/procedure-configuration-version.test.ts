import assert from "node:assert/strict";
import test from "node:test";
import { ProcedureConfiguration } from "../../craft-capability/capability/craft-experience/procedure-configuration.ts";
import { fixture, scope, spec } from "./helpers/procedure-invocation-fixture.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

test("configured Procedure freezes its candidate version across gates and renews it only after a definition change", async () => {
  const f = await fixture();
  try {
    const configuration = new ProcedureConfiguration(f.store);
    const args = { procedure_id: "versioned-configuration", scope, scenario_id: "review", title: "Review", procedure_kind: "workflow", definition: spec() };
    const first = configuration.save(args).procedure as JsonObject;
    assert.equal(first.version, 1); assert.equal(first.candidate_version, 1);
    const evidence = f.service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "Synthetic Shadow route acceptance",
      metadata: { procedure_definition_digest: first.definition_digest, entry_id: "review", exit_id: "reviewed", stage: "shadow", status: "passed" } });
    const shadow = f.service.experienceProcedureGate({ procedure_id: first.id, stage: "shadow", passed: true, evidence_ids: [evidence.id] }).procedure as JsonObject;
    assert.equal(shadow.version, 2); assert.equal(shadow.candidate_version, 1);
    const changed = configuration.save({ ...args, title: "Review changed acceptance", expected_version: shadow.version }).procedure as JsonObject;
    assert.equal(changed.version, 3); assert.equal(changed.candidate_version, 3);
    const replay = configuration.save({ ...args, title: "Review changed acceptance", expected_version: changed.version });
    assert.equal(replay.idempotent, true); assert.equal((replay.procedure as JsonObject).candidate_version, 3);
  } finally { await f.close(); }
});
