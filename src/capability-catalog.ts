/**
 * The capability set Craft ships with.
 *
 * This list is the only place the core names a capability, and it names **descriptors**, not
 * kernels. Everything the core does with them goes through {@link buildCapabilityRegistry},
 * so a capability that is removed from this list stops being constructed and the reason is
 * reported as a missing kernel rather than as an undefined property.
 *
 * It is a static list rather than a directory scan on purpose. A scan would make the set
 * depend on the filesystem at run time, so a packaged build, a bundled plugin and a checkout
 * could each assemble a different Craft with no diff to show for it; and the layering audit
 * could not rank a file whose owner is decided by a glob. The list is short, explicit, and
 * ordered — order is dependency order, because a capability may require what an earlier one
 * provided.
 *
 * All three accumulating members are now declared. `craft-memory` became declarable only after
 * `knowledge-memory-runtime.ts` — one class serving knowledge's Source registry *and* memory's
 * Ledger writes — was cut along the member boundary: each half has one owner, so each can be a
 * package. Memory's derived signals (`craft_memory_decay_get`, `craft_memory_hybrid_scores`,
 * `craft_memory_usage_record`, `craft_memory_capture_propose`, `craft_memory_promotion_preview`)
 * are still in the `craft-service.ts` facade and are therefore still **not** claimed by the
 * memory capability; that is a kernel extraction away, and it is named in
 * `capability/craft-memory/capability.ts` at the place a reader would look.
 */
import type { CraftCapability } from "./capability-protocol.ts";
import { knowledgeCapability } from "../capability/craft-knowledge/capability.ts";
import { memoryCapability } from "../capability/craft-memory/capability.ts";
import { experienceCapability } from "../capability/craft-experience/capability.ts";

/** Ordered by dependency: a capability may require a kernel an earlier one provided. */
export const CRAFT_CAPABILITIES: readonly CraftCapability[] = [
  knowledgeCapability,
  memoryCapability,
  experienceCapability,
];

/**
 * The capability that owns one tool, or `undefined` when no capability does.
 *
 * This is what turns the `owns` declarations from documentation into something the flow uses.
 * A hook at the MCP boundary is shown the owning **capability** rather than the tool name,
 * because instrumentation aggregates by capability — and deriving it here means the answer is the
 * declaration's, not a second list that could disagree with it.
 *
 * `undefined` is a real answer and not a gap: `context_resolution`, `retrieval_adapter` and the
 * several hundred workflow tools are owned by no capability by design. A caller that needs an
 * owner must handle the absence rather than receive a plausible default.
 */
export function ownerOfTool(toolName: string): string | undefined {
  return CRAFT_CAPABILITIES.find((capability) => capability.owns.test(toolName))?.name;
}
