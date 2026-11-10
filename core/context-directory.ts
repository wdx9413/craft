import type { FileDirDescRecord, FileDirDescRegistry } from "./file-dir-desc.ts";
import type { JsonObject } from "./infrastructure/store.ts";
import { CraftOperationError } from "./operation-error.ts";

/** Directory hints reuse the local registry; looking one up never observes or promotes it. */
export function resolveContextDirectory(registry: FileDirDescRegistry, args: JsonObject): JsonObject {
  if ((args.path !== undefined) === (args.description !== undefined)) {
    throw new CraftOperationError("INVALID_INPUT", "input_validation", "Provide exactly one of path or description");
  }
  const limit = args.limit ?? 3;
  const maxChars = args.max_chars ?? 1_200;
  if (!Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 5) {
    throw new CraftOperationError("INVALID_INPUT", "input_validation", "limit must be an integer from 1 to 5");
  }
  if (!Number.isInteger(maxChars) || Number(maxChars) < 1 || Number(maxChars) > 4_000) {
    throw new CraftOperationError("INVALID_INPUT", "input_validation", "max_chars must be an integer from 1 to 4000");
  }
  const resolved = registry.resolve({ path: args.path, description: args.description, limit: 1_000 });
  const matches = resolved.results as unknown as FileDirDescRecord[];
  const results: JsonObject[] = [];
  for (const match of matches) {
    const item = { id: match.id, path: match.path, description: match.description, host_kind: match.hostKind, status: match.status };
    if (results.length < Number(limit) && JSON.stringify([...results, item]).length <= Number(maxChars)) results.push(item);
  }
  const omitted = matches.length - results.length;
  return { kind: resolved.kind, results, omitted_count: omitted, partial: omitted > 0,
    registry_scan_limit: 1_000, coverage: "bounded_registry_lookup", access_granted: false };
}
