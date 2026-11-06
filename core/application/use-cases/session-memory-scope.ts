import type { CraftStore, JsonObject } from "../../infrastructure/store.ts";
import { sessionStorageScopeId } from "../../../common/craft-common-store-local/src/paths.ts";

/** Turn an explicit Host session into its private Memory partition key. */
export function hostSessionMemoryArgs(args: JsonObject, store?: CraftStore): JsonObject {
  if (args.scope_kind !== "session" || typeof args.scope_id !== "string") return args;
  const host = typeof args.session_host === "string" ? args.session_host : undefined;
  if (host) store?.bindSessionStorageHost(args.scope_id, host);
  const scopeId = store?.resolveSessionStorageScopeId(args.scope_id, host)
    ?? (host ? sessionStorageScopeId(host, args.scope_id) : args.scope_id);
  return scopeId === args.scope_id ? args : { ...args, scope_id: scopeId };
}
