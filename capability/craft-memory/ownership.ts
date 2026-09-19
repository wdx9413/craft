/**
 * Which tools the Memory capability owns, and which ones its product exposes.
 *
 * Memory's ownership is the **narrowest of the three** members, and the reason is worth stating
 * because it is not a gap in this package: reading memory back is `ContextResolutionKernel.resolve`
 * in `src/context-resolution.ts`, which lives in the core because `component-knowledge`,
 * `component-memory` and `component-context` all expose it. A Host that loads only the Memory
 * product still needs to resolve what it stored, so the read verb cannot belong here.
 *
 * So this capability owns exactly the Ledger's writes:
 *
 * | family | served by |
 * |---|---|
 * | `craft_memory_ledger_remember` / `_ledger_transition` / `_ledger_compat_bind` | `MemoryLedgerKernel` |
 *
 * **`craft_memory_remember` and `craft_memory_transition` are deliberately not claimed**, and an
 * earlier version of this file claimed them on the assumption that they were the Ledger's older
 * names. They are not: both are served by `WorkbenchKernel` over the legacy `memory_item`
 * collection, which this package does not assemble. The capability's own test asserted the wrong
 * claim, so the mistake survived until the handler map was read — which is precisely the failure
 * that a declaration which cannot be wrong would have hidden.
 *
 * The derived signals (`craft_memory_decay_get`, `craft_memory_hybrid_scores`,
 * `craft_memory_usage_record`, `craft_memory_capture_propose`, `craft_memory_promotion_preview`)
 * **are** claimed: they are pure functions over recall history in `memory-signals.ts`, which was
 * `src/memory-wiring.ts` until it moved here. Claiming them needed no behaviour change, only the
 * file move — which is the point of keeping the ownership declaration honest rather than
 * aspirational.
 *
 * So the ledger writes and the derived signals are owned; three families are not, for two
 * reasons: the shared read side belongs to no capability, and the consolidation family is a
 * separate kernel this package does not assemble.
 */

/** Tool families the Memory package's kernels implement. */
export const MEMORY_FAMILIES = "craft_memory_(?:ledger_(?:remember|transition|compat_bind)|decay_get|hybrid_scores|usage_record|capture_propose|promotion_preview)\\b";

/**
 * The frozen memory name space, used by `component-context`.
 *
 * `component-context` composes knowledge and memory, and its membership is a compatibility
 * surface: it matched `craft_memory*` before this package existed and must keep doing so, for a
 * reason that has nothing to do with the split.
 */
export const MEMORY_CONTEXT_SOURCE = "craft_memory";

/**
 * The Knowledge Source bootstrap verbs, which this product also exposes.
 *
 * A Memory entry's provenance **is** a Knowledge Source — `remember` refuses a Source that is
 * not active — so a Host that loads only the Memory product still has to be able to register the
 * Source its entries cite. The family belongs to the knowledge package under `owns`; here it is
 * projected.
 *
 * `knowledge_memory_install_builtins` is included because it is the same handler as
 * `knowledge_bootstrap_install` under an older name, and excluding it would mean the older name
 * was unreachable through the product while its newer alias was reachable. That was the previous
 * behaviour, and it was an inconsistency rather than a policy.
 */
const KNOWLEDGE_BOOTSTRAP = "craft_(?:knowledge_source_|knowledge_bootstrap_install|knowledge_memory_install_builtins)";

/**
 * The shared context verbs, which no capability owns.
 *
 * `component-memory` has always exposed them, because memory entries must be resolvable through
 * the product named after them — that is the third way this projection is wider than ownership.
 */
const SHARED_CONTEXT = "craft_(?:context_resolution|retrieval_adapter)";

/** What the capability owns: matched against a tool name. */
export const MEMORY_OWNS = new RegExp(`^${MEMORY_FAMILIES}`);

/**
 * The projection's alternatives, as a source string.
 *
 * Exported so `component-context` can compose knowledge and memory without restating either, and
 * so nothing has to splice one compiled `RegExp` into another by stripping an anchor.
 */
export const MEMORY_COMPONENT_SOURCE = `craft_memory_|${KNOWLEDGE_BOOTSTRAP}|${SHARED_CONTEXT}`;

/** What the `component-memory` surface exposes. */
export const MEMORY_COMPONENT = new RegExp(`^(?:${MEMORY_COMPONENT_SOURCE})`);
