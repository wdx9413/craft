/**
 * Which tools the Experience capability owns, and which ones its product exposes.
 *
 * Split out from `capability.ts` so that the MCP surface registry can derive its projection
 * from this file without importing the kernel implementations. Surface resolution happens
 * while a Host is choosing a product, before any kernel exists; loading three kernels to read
 * a regular expression would make the cheap decision depend on the expensive one.
 *
 * The two patterns answer two different questions and are deliberately not the same:
 *
 *  - **ownership** — which tools this capability *implements*. Every alternative names a
 *    family served by `experience-ledger`, `workflow-evolution` or `evaluation-model-profile`,
 *    and the list is narrow for that reason. `craft_experience_mine`,
 *    `craft_experience_pattern_*`, `craft_experience_candidate_list`,
 *    `craft_experience_shadow_experiment_*` and `craft_experience_capture_*` are separate
 *    kernels this capability does not assemble, so it does not claim them. A wider
 *    `^craft_experience_` would read better and would be false: the value of declaring
 *    ownership is that the declaration can be wrong.
 *
 *  - **projection** — which tools the `component-experience` product *exposes*. It is
 *    ownership plus the families a separate kernel implements but the same product serves,
 *    because a Host that loads the Experience product needs its whole surface, not only the
 *    part this package happens to own.
 *
 * The projection was previously a restated literal, and it had drifted: it matched
 * `experience_mine|experience_candidate|experience_shadow`, none of which is
 * `craft_experience_ledger_*` — so the ledger, which is the write side of experience, was
 * unreachable through the product named after it, and nothing reported that because the
 * surface list and the implementation had no relationship anything could check.
 */

/** Tool families the three Experience kernels implement. The single source for both patterns. */
export const EXPERIENCE_FAMILIES = "craft_(?:experience_ledger_|workflow_evolution_|evaluation_model_|route_workflow_proposal|workflow_(?:save|get|search|transition|rollback))";

/** Families a separate kernel implements and the Experience product also serves. */
const EXPERIENCE_PRODUCT_EXTRAS = "craft_(?:experience_pattern_|experience_candidate_list|experience_mine|experience_shadow_experiment_|experience_capture_|workflow_(?:dag_validate|dag_save|dag_transition|checkpoint|resume|run_cancel|replan|export|import))";

/** What the capability owns: matched against a tool name. */
export const EXPERIENCE_OWNS = new RegExp(`^${EXPERIENCE_FAMILIES}`);

/** What the `component-experience` surface exposes: ownership plus the shared extras. */
export const EXPERIENCE_COMPONENT = new RegExp(`^(?:${EXPERIENCE_FAMILIES}|${EXPERIENCE_PRODUCT_EXTRAS})`);
