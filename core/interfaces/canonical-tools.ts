import { ACTIVE_TOOLS } from "./mcp-server.ts";
import type { Tool } from "../mcp/tool-schema.ts";

/**
 * The canonical `craft_*` catalog, resolved lazily.
 *
 * `mcp-server.ts` imports the service facade, so a static import of its tool
 * table from the foundation would close an import cycle. The internal loop only
 * needs the *table* (names, descriptions, schemas) at construction time, so this
 * accessor keeps the catalog a single source without inlining a second copy.
 *
 * The returned array is a fresh copy: callers filter and project it, and a
 * caller that mutated the shared array would silently change every surface.
 */
export function canonicalToolCatalog(): readonly Tool[] {
  return [...ACTIVE_TOOLS];
}
