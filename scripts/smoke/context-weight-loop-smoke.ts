import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore, type JsonObject } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CraftService } from "../../core/service.ts";
import { ContextResolutionKernel } from "../../core/context-resolution.ts";
import { ExperienceContribution } from "../../capability/craft-experience/contribution.ts";

/**
 * Runtime smoke for the governed experience loop:
 * candidate is not recallable -> ordered gates promote it -> recall succeeds ->
 * a helpful signal with same-receipt program evidence raises the weight to 1.2.
 *
 * Run: node --experimental-strip-types scripts/smoke/context-weight-loop-smoke.ts
 */
const root = await mkdtemp(join(tmpdir(), "craft-context-weight-smoke-"));
const store = await new CraftStore(craftPaths(root)).open();
const service = new CraftService(store);
try {
  service.scopeAliasBind({ scope_kind: "project", scope_id: "project:smoke", alias_kind: "path", alias: root });
  const procedureId = "procedure_smoke_weight";
  store.create("experience_procedure", procedureId, { scope: "project:smoke", lifecycle: "candidate",
    routeable: false, completed_gates: [], trigger: "smoke weight", title: "smoke weight",
    content_digest: "smoke-weight", procedure_kind: "prompt", acceptance_ref: "file",
    scenario_signature: {}, identity_digest: "smoke-weight" });
  const gateEvidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed",
    claim: "smoke gate evidence", locator: "smoke://gate" }) as JsonObject;
  const reader = new ContextResolutionKernel(store, [new ExperienceContribution(store)]);
  const query = { query: "smoke weight", scope_kind: "project", scope_id: "smoke",
    required_refs: [{ member: "experience", id: procedureId }] };

  await assert.rejects(reader.resolve(query), /Required Context reference is unavailable/u);
  console.log("PASS candidate is not recallable before gates");

  for (const stage of ["shadow", "held_out", "signoff", "canary"]) {
    service.experienceProcedureGate({ procedure_id: procedureId, stage, passed: true, verdict: "passed",
      evidence_ids: [String(gateEvidence.id)] });
  }
  const promoted = store.get("experience_procedure", procedureId);
  assert.equal(promoted.routeable, true);
  assert.equal(promoted.lifecycle, "routeable");
  console.log("PASS ordered gates promote the procedure to routeable");

  const resolved = await reader.resolve(query);
  const receipt = resolved.receipt as JsonObject;
  assert.ok(receipt && typeof receipt.id === "string");
  console.log(`PASS recall wrote receipt ${String(receipt.id)}`);

  const verdictEvidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed",
    claim: "smoke verdict passed", locator: "smoke://verdict",
    metadata: { context_receipt_id: String(receipt.id), verdict: "passed" } }) as JsonObject;
  service.contextResolutionFeedback({ receipt_id: String(receipt.id), outcome: "helpful", usage_stage: "used",
    evidence_ids: [String(verdictEvidence.id)], asset_refs: [{ member: "experience", id: procedureId }] });
  const history = service.workbenchExperienceFeedbackHistory({ asset_id: procedureId, member: "experience" }) as JsonObject;
  assert.equal(history.current_weight, 1.2);
  assert.equal((history.counts as JsonObject).positive, 1);
  console.log("PASS counted helpful feedback raised the weight to 1.20");
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}
