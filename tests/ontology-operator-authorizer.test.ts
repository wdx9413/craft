import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { ontologyOperatorAuthorizationDigest, ontologyOperatorAuthorizer, parseTrustedOntologyOperators } from "../core/ontology-operator-authorizer.ts";
import type { JsonObject } from "../core/infrastructure/store.ts";

test("Ontology operator controls require an exact Runtime-pinned Ed25519 signature", () => {
  const keys = generateKeyPairSync("ed25519");
  const operator = { id: "operator-1", public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
  const registry = [operator];
  const input: JsonObject = { action: "revoke", actor: operator.id, active_pointer_id: "pointer-4", target_pointer_id: null,
    request_id: "request-1", expected_pointer_revision: 4, stage: "project", cohort_id: null,
    scope: { kind: "project", id: "project-a" }, reason: "human-requested-revoke" };
  const signature = sign(null, Buffer.from(ontologyOperatorAuthorizationDigest(operator.id, input)), keys.privateKey).toString("base64");
  assert.equal(ontologyOperatorAuthorizer(operator.id, signature, registry).authorize(input), true);
  assert.equal(ontologyOperatorAuthorizer("other-operator", signature, registry).authorize(input), false);
  assert.equal(ontologyOperatorAuthorizer(operator.id, "not-base64!", registry).authorize(input), false);
  assert.equal(ontologyOperatorAuthorizer(operator.id, "AA==", registry).authorize(input), false);
  assert.equal(ontologyOperatorAuthorizer(operator.id, signature, [{ ...operator, public_key_pem: "invalid" }]).authorize(input), false);
  assert.equal(ontologyOperatorAuthorizer(operator.id, signature, []).authorize(input), false);
  assert.equal(ontologyOperatorAuthorizer(operator.id, signature, registry).authorize({ ...input, reason: "changed" }), false);
});

test("Ontology operator registry rejects malformed, duplicate and non-array configuration", () => {
  const keys = generateKeyPairSync("ed25519");
  const operator = { id: "operator-1", public_key_pem: keys.publicKey.export({ type: "spki", format: "pem" }).toString() };
  assert.deepEqual(parseTrustedOntologyOperators(""), []);
  assert.deepEqual(parseTrustedOntologyOperators(JSON.stringify([operator])), [operator]);
  for (const invalid of ["{", "{}", JSON.stringify([null]), JSON.stringify([{}]),
    JSON.stringify([{ ...operator, id: "invalid id" }]), JSON.stringify([operator, operator])]) {
    assert.throws(() => parseTrustedOntologyOperators(invalid));
  }
});
