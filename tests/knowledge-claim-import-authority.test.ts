import assert from "node:assert/strict";
import test from "node:test";
import { portableKnowledgeClaimForImport } from "../core/knowledge-claim-import.ts";

test("only portable reviewed Knowledge annotations lose authority on import", () => {
  const candidate = { id: "candidate", status: "candidate", review: null };
  assert.equal(portableKnowledgeClaimForImport(candidate), candidate);
  const reviewed = { id: "reviewed", status: "reviewed", review: { reviewer: "automated-promotion-policy" } };
  assert.deepEqual(portableKnowledgeClaimForImport(reviewed), { id: "reviewed", status: "candidate", review: null,
    imported_review: reviewed.review, qualification_status: "revalidation_required_after_import" });
  assert.deepEqual(portableKnowledgeClaimForImport({ id: "reviewed-without-note", status: "reviewed" }), {
    id: "reviewed-without-note", status: "candidate", imported_review: null, review: null,
    qualification_status: "revalidation_required_after_import",
  });
});
