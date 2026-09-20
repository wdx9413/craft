/**
 * Which tools the Knowledge capability owns, and which ones its product exposes.
 *
 * Split from `capability.ts` for the same reason as the Experience package: the MCP surface
 * registry reads this file to build its projection, and importing kernel classes to obtain a
 * regular expression would make choosing a product depend on constructing kernels.
 *
 * Ownership and projection are now the **same broad name space**, and that is a change this
 * package earned rather than declared: the Knowledge Source registry used to live in the core
 * (`knowledge-memory-runtime.ts`, one class serving this member's Sources *and* memory's Ledger
 * writes), so the capability could not claim `craft_knowledge_source_*` and the product had to
 * project tools the package did not assemble. Cutting that class along the member boundary moved
 * the registry here, so the families are claimed rather than projected on someone else's behalf.
 *
 * The distinction still matters, and `component-memory` is where it shows: that product also
 * exposes the bootstrap verbs, because a memory entry's provenance *is* a Knowledge Source, so a
 * Host loading only Memory still has to register the Source its entries cite. Ownership answers
 * "who implements it"; the projection answers "what does this Host see".
 */

/**
 * Tool families the Knowledge package's eight kernels implement.
 *
 * Each alternative names a family whose implementation is one of the kernels in this directory,
 * checked against `craft-service.ts`: `craft_knowledge_source_*` and
 * `craft_knowledge_memory_install_builtins` are `KnowledgeSourceRegistry`, `craft_relation_*` is
 * `KnowledgeRelationKernel`, `craft_knowledge_workbench` and
 * `craft_knowledge_context_bundle_preview` are `KnowledgeWorkbenchKernel`,
 * `craft_knowledge_context_work_launch_*` is `KnowledgeBoundLaunchKernel`,
 * `craft_wiki_skill_candidate_*` is `WikiCandidateGovernanceKernel`,
 * `craft_wiki_candidate_local_import*` is `LocalCandidateImportKernel`,
 * `craft_project_knowledge_*`, `craft_knowledge_index_*`, `craft_knowledge_search` and
 * `craft_knowledge_scope_*` are `ProjectKnowledgeKernel`, and `craft_project_brain_*` is
 * `ProjectBrainKernel`.
 *
 * Note what is still absent: `craft_knowledge_claim_*`, `craft_wiki_page_*` and
 * `craft_knowledge_evaluation_*` live in `craft-service.ts` and `wiki-candidate-governance.ts`
 * respectively rather than in a kernel this package assembles, so they are projected by the
 * product and not claimed as ownership. `craft_knowledge_bootstrap_install` is a second name for
 * `installBuiltins`, so it is owned.
 */
export const KNOWLEDGE_FAMILIES = "craft_(?:relation_|knowledge_source_|knowledge_memory_install_builtins|knowledge_bootstrap_install|knowledge_workbench|knowledge_context_work_launch|knowledge_context_bundle_preview|knowledge_index_|knowledge_search|knowledge_scope_|wiki_skill_candidate_|wiki_candidate_local_import|project_knowledge_|project_brain_)";

/**
 * The product projection, kept as the name space it has always been, plus one repair.
 *
 * `component-knowledge` is a Host-facing promise about a *name space*, not about this package:
 * a Host loading it expects `craft_wiki_*`, `craft_knowledge_*`, `craft_claim_*` and
 * `craft_relation_*`, including the parts the facade still implements. Narrowing it to
 * `KNOWLEDGE_FAMILIES` would remove `craft_knowledge_claim_save` from the product, which is a
 * user-visible regression rather than a cleanup.
 *
 * `project` is **added**, and that is a repair rather than a widening for its own sake: two of
 * this package's kernels — `project-knowledge` and `project-brain` — serve
 * `craft_project_knowledge_*` and `craft_project_brain_*`, and the previous name space matched
 * neither. So the product named after this capability could not reach two of the kernels the
 * capability assembles, and nothing reported that because ownership and the projection had no
 * relationship anything checked. `craft_project_*` is already a `knowledge`-domain family in
 * `SURFACE_RULES`, so this aligns the product with the domain instead of crossing it.
 */
const KNOWLEDGE_NAMESPACE = "craft_(?:wiki|knowledge|claim|relation|project)";

/**
 * The name space `component-context` composes, which is deliberately **not** the one above.
 *
 * `component-context` is the older, narrower projection, and its membership is a compatibility
 * surface: adding `project` to it would change what an existing Host sees for a reason that is
 * not about that Host. Two constants, therefore, and the difference between them is a decision
 * on the record rather than an oversight.
 */
const KNOWLEDGE_CONTEXT_NAMESPACE = "craft_(?:wiki|knowledge|claim|relation)";

const SHARED_CONTEXT = "craft_(?:context_resolution|decision_context_gate|retrieval_adapter)";

/** What the capability owns: matched against a tool name. */
export const KNOWLEDGE_OWNS = new RegExp(`^${KNOWLEDGE_FAMILIES}`);

/**
 * The projection's alternatives, as a source string.
 *
 * Exported so `component-context` can compose knowledge and memory without restating either,
 * and without splicing one compiled `RegExp` into another by stripping an anchor.
 */
export const KNOWLEDGE_COMPONENT_SOURCE = `${KNOWLEDGE_NAMESPACE}|${SHARED_CONTEXT}`;

/** The frozen name space `component-context` composes. */
export const KNOWLEDGE_CONTEXT_SOURCE = `${KNOWLEDGE_CONTEXT_NAMESPACE}|${SHARED_CONTEXT}`;

/** What the `component-knowledge` surface exposes. */
export const KNOWLEDGE_COMPONENT = new RegExp(`^(?:${KNOWLEDGE_COMPONENT_SOURCE})`);
