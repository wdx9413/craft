import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import type { CraftStore } from "../core/infrastructure/store.ts";
import { TrustedExperienceEvaluator } from "../core/trusted-experience-evaluator.ts";

test("a newer revoked evaluator policy blocks receipts from already-issued requests", () => {
  const root = generateKeyPairSync("ed25519");
  const policyHistory = new Map<number, Record<string, unknown>>([
    [1, { id: "policy-a", version: 1, evaluator_id: "evaluator-a", revoked: false, public_key_pem: root.publicKey.export({ type: "spki", format: "pem" }) }],
    [2, { id: "policy-a", version: 2, evaluator_id: "evaluator-a", revoked: true, public_key_pem: root.publicKey.export({ type: "spki", format: "pem" }) }],
  ]);
  const request = { id: "request-a", policy_id: "policy-a", policy_version: 1, status: "issued" };
  const store = {
    transaction: <T>(work: () => T) => work(),
    get: (kind: string, id: string, version?: number) => {
      assert.equal(kind, "experience_evaluator_request"); assert.equal(id, request.id);
      return request;
    },
    find: (kind: string, id: string) => {
      assert.equal(kind, "experience_evaluator_policy"); assert.equal(id, "policy-a");
      return policyHistory.get(2)!;
    },
    save: () => { throw new Error("revoked receipt must not be persisted"); },
  } as unknown as CraftStore;
  const evaluator = new TrustedExperienceEvaluator(store, String(root.publicKey.export({ type: "spki", format: "pem" })));
  let gateCalled = false;
  assert.throws(() => evaluator.verifyReceipt({ request_id: request.id, signature: "AQ", receipt: {} }, () => {
    gateCalled = true; return {};
  }), /revoked or changed/u);
  assert.equal(gateCalled, false);
});
