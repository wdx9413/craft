import type { CraftStore, JsonObject } from "../../common/craft-common-store-local/src/store.ts";
import { scopeAccess, scopeAllows, scopeEnvelope, scopeFromKey, sourceAllows } from "../../common/craft-common-base/src/scope-policy.ts";

/** Apply current claim and Source policy before hydrating an exact or listed claim. */
export function claimReadable(store: CraftStore, claim: JsonObject, args: JsonObject): boolean {
  const applicability = scopeFromKey(String(claim.scope));
  if (args.scope_kind !== undefined && args.scope_kind !== applicability.kind) return false;
  if (args.scope_id !== undefined && args.scope_id !== applicability.id) return false;
  const access = scopeAccess(args);
  if (!scopeAllows(scopeEnvelope(claim.scope_envelope, applicability), access)
    || claim.sensitivity === "restricted" && args.allow_restricted !== true) return false;
  const sourceId = typeof claim.source_id === "string" ? claim.source_id : null;
  if (!sourceId) return false;
  const source = store.find("knowledge_source", sourceId);
  if (!source || source.status !== "active" || source.trust === "untrusted" || !sourceAllows(source, access)) return false;
  return true;
}
