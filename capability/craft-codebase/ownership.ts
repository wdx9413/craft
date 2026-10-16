/**
 * The internal `craft-codebase` Capability owns only structural repository
 * analysis.  It deliberately does not own a Context member or an external
 * product projection: an index is a rebuildable view of one Workspace
 * checkpoint, not accumulated Knowledge, Memory, or Experience.
 */
export const CODEBASE_FAMILIES = "craft_codebase_(?:activate|deactivate|status|index_build|analysis_import|symbol_find|symbol_explore|symbol_read|symbols_overview|callers_find|relations_find|definition_find|control_flow_query|data_flow_query|diagnostics_find|impact_query|context_slice)\\b";

/** Tools implemented by kernels in this directory. */
export const CODEBASE_OWNS = new RegExp(`^${CODEBASE_FAMILIES}`);
