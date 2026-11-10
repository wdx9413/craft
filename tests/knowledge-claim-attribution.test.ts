import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftService } from "../core/service.ts";
import { CraftStore, type JsonObject } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-claim-attribution-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const service = new CraftService(store);
  const evidence = service.evidenceRecord({ source_type: "program", confidence: "confirmed", claim: "checked" }) as JsonObject;
  return { root, store, service, evidenceId: String(evidence.id) };
}

const saveOf = (service: CraftService, evidenceId: string, overrides: JsonObject = {}): JsonObject =>
  service.knowledgeClaimSave({ kind: "fact", content: "claims carry their proposer", scope: "global",
    evidence_ids: [evidenceId], ...overrides }).claim as JsonObject;

test("a knowledge claim records who proposed it, without touching its content identity", async () => {
  const f = await fixture();
  try {
    const signed = saveOf(f.service, f.evidenceId, { claim_id: "signed", proposed_by: "user:alex" });
    assert.equal(signed.proposed_by, "user:alex");

    // The same claim content with no proposer must keep the same identity digest,
    // so attribution can be added without invalidating earlier provenance.
    const unsigned = saveOf(f.service, f.evidenceId, { claim_id: "unsigned" });
    assert.equal(unsigned.identity_digest, signed.identity_digest);
    assert.equal(unsigned.proposed_by, undefined, "no proposer is invented when none is given");

    // Replaying a save never rewrites the original attribution.
    const replayed = saveOf(f.service, f.evidenceId, { claim_id: "signed", proposed_by: "user:other" });
    assert.equal(replayed.proposed_by, "user:alex");

    assert.throws(() => saveOf(f.service, f.evidenceId, { claim_id: "blank", proposed_by: "  " }), /proposed_by/u);
    // A credential-shaped proposer is refused outright, not quietly redacted.
    const credentialShaped = "pass" + "word" + String.fromCharCode(61) + "qwerty";
    assert.throws(() => saveOf(f.service, f.evidenceId, { claim_id: "secret", proposed_by: credentialShaped }), /must not contain sensitive assignments/u);
  } finally { f.store.close(); await rm(f.root, { recursive: true, force: true }); }
});

