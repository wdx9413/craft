/**
 * The internal `craft-codebase` Capability owns only structural repository
 * analysis.  It deliberately does not own a Context member or an external
 * product projection: an index is a rebuildable view of one Workspace
 * checkpoint, not accumulated Knowledge, Memory, or Experience.
 */
export const CODEBASE_FAMILIES = "craft_codebase_(?:activate|deactivate|status|index_build|symbol_find|callers_find|impact_query|context_slice)\\b";

/** Tools implemented by kernels in this directory. */
export const CODEBASE_OWNS = new RegExp(`^${CODEBASE_FAMILIES}`);
