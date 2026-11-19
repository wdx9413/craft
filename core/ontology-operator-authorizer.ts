import { verify as verifySignature } from "node:crypto";
import type { JsonObject } from "./infrastructure/store.ts";
import { stableDigest } from "./digest.ts";

export interface TrustedOntologyOperator { id: string; public_key_pem: string }

export function parseTrustedOntologyOperators(value = process.env.CRAFT_ONTOLOGY_TRUSTED_OPERATORS): TrustedOntologyOperator[] {
  if (value === undefined || value.trim() === "") return [];
  let entries: unknown;
  try { entries = JSON.parse(value); } catch { throw new Error("CRAFT_ONTOLOGY_TRUSTED_OPERATORS must be a JSON array"); }
  if (!Array.isArray(entries)) throw new Error("CRAFT_ONTOLOGY_TRUSTED_OPERATORS must be a JSON array");
  const operators = entries.map((entry): TrustedOntologyOperator => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Trusted Ontology operator must be an object");
    const record = entry as JsonObject;
    if (typeof record.id !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(record.id)
      || typeof record.public_key_pem !== "string" || !record.public_key_pem.includes("BEGIN PUBLIC KEY")) {
      throw new Error("Trusted Ontology operator requires a bounded id and public key");
    }
    return { id: record.id, public_key_pem: record.public_key_pem };
  });
  if (new Set(operators.map(operator => operator.id)).size !== operators.length) throw new Error("Trusted Ontology operator ids must be unique");
  return operators;
}

export function ontologyOperatorAuthorizationDigest(operatorId: string, control: JsonObject): string {
  return stableDigest({ schema: "craft.ontology.operator-control.v1", operator_id: operatorId, control });
}

export function ontologyOperatorAuthorizer(operatorId: string, signature: string,
  trustedOperators = parseTrustedOntologyOperators()): { authorize(input: JsonObject): boolean } {
  const trusted = trustedOperators.find(operator => operator.id === operatorId);
  return { authorize(input) {
    if (!trusted || input.actor !== operatorId || typeof signature !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(signature)) return false;
    try {
      return verifySignature(null, Buffer.from(ontologyOperatorAuthorizationDigest(operatorId, input)), trusted.public_key_pem,
        Buffer.from(signature, "base64"));
    } catch { return false; }
  } };
}
