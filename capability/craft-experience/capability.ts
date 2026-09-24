/**
 * The Experience capability.
 *
 * Experience is the accumulated Context member. Its governed output is a Procedure: a
 * workflow, graph, or short prompt-shaped procedure. These Craft-owned learned assets are
 * deliberately separate from installed Capability Skills and Workflows.
 *
 * The package owns three kernels and nothing else:
 *
 * | kernel | what it holds |
 * |---|---|
 * | `experience-ledger` | content-free, Evidence-backed observations and their diagnostic patterns |
 * | `workflow-evolution` | sanitized execution observations, and the bounded model-proposal request they justify |
 * | `evaluation-model-profile` | the secret-free model configuration an evaluation runs under |
 *
 * Its read side returns only scoped, routeable Procedures: checked JSON definitions for
 * Workflow/Graph and Markdown-native Prompt Procedures. Observation, patterns and candidates
 * stay diagnostic; they cannot become Context merely by existing.
 */
import type { CraftCapability } from "../../core/capability-protocol.ts";
import { CORE_KERNELS } from "../../core/capability-protocol.ts";
import type { CraftStore } from "../../core/infrastructure/store.ts";
import type { ModelProviderSpec } from "../../core/model-gateway.ts";
import { ExperienceContribution } from "./contribution.ts";
import { EvaluationModelProfileKernel } from "./evaluation-model-profile.ts";
import { ExperienceLedgerKernel } from "./experience-ledger.ts";
import { ProcedureStore } from "./procedure-projection.ts";
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
  procedures: "experience.procedures",
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
  evaluation: { input_contract: "sanitized-observation", output_contract: "gated-experience-candidate", fixture_id: "experience-fixture-v1", host_compatibility: ["fixture", "codex", "claude"] },
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
    registry.provide(EXPERIENCE_KERNELS.procedures, new ProcedureStore(store));
    registry.provide(EXPERIENCE_KERNELS.modelProfiles, new EvaluationModelProfileKernel(store, providers));
  },
  /**
   * Context receives only routeable Procedure projections. This keeps diagnostic learning useful
   * without letting unproven inference steer a Host.
   */
  contributes: (registry) => new ExperienceContribution(registry.require<CraftStore>(CORE_KERNELS.store)),
};
