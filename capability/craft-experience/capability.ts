/**
 * The Experience capability.
 *
 * Experience is the accumulated context member whose carrier is a Workflow. It is named
 * after the concept rather than the carrier on purpose: the Workflow is the current shape a
 * proven strategy takes, and a graph or a profile would be another. `evolution` is the
 * overall accumulation mechanism that spans all three accumulating members, so it names the
 * mechanism, not this one member.
 *
 * The package owns three kernels and nothing else:
 *
 * | kernel | what it holds |
 * |---|---|
 * | `experience-ledger` | content-free, Evidence-backed observations and their diagnostic patterns |
 * | `workflow-evolution` | sanitized execution observations, and the bounded model-proposal request they justify |
 * | `evaluation-model-profile` | the secret-free model configuration an evaluation runs under |
 *
 * It declares no `contributes` yet, and that is a measured gap rather than a design choice:
 * every tool this capability exposes is on the **write** side — observe, compile, propose,
 * decide — and no Craft tool reads experience back into a turn's context. Recorded here so
 * the absence is visible at the place a reader would look for the read side, instead of
 * being inferred from a tool list.
 */
import type { CraftCapability } from "../../src/capability-protocol.ts";
import { CORE_KERNELS } from "../../src/capability-protocol.ts";
import type { CraftStore } from "../../src/infrastructure/store.ts";
import type { ModelProviderSpec } from "../../src/model-gateway.ts";
import { ExperienceContribution } from "./contribution.ts";
import { EvaluationModelProfileKernel } from "./evaluation-model-profile.ts";
import { ExperienceLedgerKernel } from "./experience-ledger.ts";
import { EXPERIENCE_OWNS } from "./ownership.ts";
import { WorkflowEvolutionKernel } from "./workflow-evolution.ts";

/**
 * Kernel names this capability registers, and the core requires back.
 *
 * Namespaced, so two capabilities cannot both provide a bare `ledger` and neither has to
 * know the other exists to avoid the collision. These strings are the whole interface: the
 * core names a kernel, never a file or a class.
 */
export const EXPERIENCE_KERNELS = {
  ledger: "experience.ledger",
  workflowEvolution: "experience.workflow_evolution",
  modelProfiles: "experience.model_profiles",
} as const;

/**
 * Tool families this capability implements.
 *
 * Declared in `ownership.ts` alongside the product projection, because the two have to agree
 * and keeping them in one file is what makes disagreement visible. Read there for why the
 * list is narrow.
 */
export { EXPERIENCE_OWNS };

export const experienceCapability: CraftCapability = {
  name: "experience",
  product: "craft-experience",
  owns: EXPERIENCE_OWNS,
  /**
   * Assemble the kernels from the environment the core already decided.
   *
   * Nothing here reads a settings file or a path: a capability that resolved its own
   * environment could not be replaced by a differently configured one, and the model
   * catalogue in particular is a first-run decision that must be made before any capability
   * is chosen.
   */
  register(registry): void {
    const store = registry.require<CraftStore>(CORE_KERNELS.store);
    const providers = registry.require<readonly ModelProviderSpec[]>(CORE_KERNELS.modelProviders);
    registry.provide(EXPERIENCE_KERNELS.ledger, new ExperienceLedgerKernel(store));
    registry.provide(EXPERIENCE_KERNELS.workflowEvolution, new WorkflowEvolutionKernel(store));
    registry.provide(EXPERIENCE_KERNELS.modelProfiles, new EvaluationModelProfileKernel(store, providers));
  },
  /**
   * The read side, which is the only one of the three members that has one.
   *
   * Knowledge and memory read back through `ContextResolutionKernel.resolve` in the core; experience
   * cannot, because its records are content-free by construction and marked
   * `execution_visible: false`. So it contributes what it *can* honestly contribute — which compiled
   * experience applies, at which version, and whether anything reached Signoff — and never the
   * instructions, which do not exist in Craft to leak in the first place.
   */
  contributes: (registry) => new ExperienceContribution(registry.require<CraftStore>(CORE_KERNELS.store)),
};
