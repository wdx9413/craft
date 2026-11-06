import type { JsonObject } from "../common/craft-common-store-local/src/store.ts";

/** Portable annotations are history; managed promotion authority is local. */
export function portableKnowledgeClaimForImport(payload: JsonObject): JsonObject {
  if (payload.status !== "reviewed") return payload;
  return { ...payload, imported_review: payload.review ?? null, review: null, status: "candidate",
    qualification_status: "revalidation_required_after_import" };
}
