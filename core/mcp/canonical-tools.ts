import { ACTIVE_TOOLS } from "./tool-catalog.ts";
import type { Tool } from "./tool-schema.ts";

/** Return a fresh view of the transport-independent catalog. */
export function canonicalToolCatalog(): readonly Tool[] {
  return [...ACTIVE_TOOLS];
}
