import { KnowledgeClaimGovernance } from "./claim-governance.ts";
/**
 * The Knowledge capability.
 *
 * Knowledge is the accumulated context member gated by Evidence: a saved Claim carries the
 * Evidence that backs it, and a Wiki page carries the claim identity rather than a copy of it.
 * That gate is why this member is a capability and not a convenience store.
 *
 * The package owns nine kernels:
 *
 * | kernel | what it holds |
 * |---|---|
 * | `knowledge-claim-governance` | reviewed claim lifecycle and governed reads |
 * | `knowledge-source-registry` | source identity, trust and availability shared with Memory |
 * | `knowledge-workbench` | the bounded read-only Workbench projection and a Context Bundle preview |
 * | `knowledge-bound-launch` | a Work Launch pinned to one exact Context Bundle, revalidated before any Host run |
 * | `knowledge-relation` | typed, evidence-backed relations between addressable knowledge objects |
 * | `wiki-candidate-governance` | attestation, publication authorization and portable package preparation |
 * | `local-candidate-import` | writing one reviewed package to a user-selected path, without executing it |
 * | `project-knowledge` | the rebuildable Markdown index projection, its search and its scope expiry |
 * | `project-brain` | the project's goals, decisions, bound material and recorded outcomes |
 *
 * The core service facade delegates claim and source operations to these kernels.
 * Wiki page write orchestration remains in the facade.
 *
 * Its `KnowledgeContribution` is the one governed read side used by Context Resolution.  It
 * projects only reviewed claims; diagnostic searches may expose candidates to a human, but a
 * candidate can never enter an execution Host's Context merely because it was imported.
 */
import type { CraftCapability } from "../../common/craft-common-base/src/capability-protocol.ts";
import { CORE_KERNELS } from "../../common/craft-common-base/src/capability-protocol.ts";
import type { CraftStore } from "../../common/craft-common-store-local/src/store.ts";
import { KnowledgeBoundLaunchKernel } from "./knowledge-bound-launch.ts";
import { KnowledgeRelationKernel } from "./knowledge-relation.ts";
import { KnowledgeSourceRegistry } from "./knowledge-source-registry.ts";
import { KnowledgeWorkbenchKernel } from "./knowledge-workbench.ts";
import { LocalCandidateImportKernel } from "./local-candidate-import.ts";
import { KNOWLEDGE_OWNS } from "./ownership.ts";
import { ProjectBrainKernel } from "./project-brain.ts";
import { ProjectKnowledgeKernel } from "./project-knowledge.ts";
import { WikiCandidateGovernanceKernel } from "./wiki-candidate-governance.ts";
import { KnowledgeContribution } from "./contribution.ts";

/**
 * Kernel names this capability registers, and the core requires back.
 *
 * Namespaced for the same reason as Experience: two capabilities cannot both provide a bare
 * `workbench` and neither has to know the other exists to avoid the collision.
 */
export const KNOWLEDGE_KERNELS = {
  sources: "knowledge.sources",
  claims: "knowledge.claims",
  boundLaunch: "knowledge.bound_launch",
  workbench: "knowledge.workbench",
  relations: "knowledge.relations",
  wikiCandidates: "knowledge.wiki_candidates",
  localImport: "knowledge.local_import",
  projectKnowledge: "knowledge.project_knowledge",
  projectBrain: "knowledge.project_brain",
} as const;

/**
 * Tool families this capability implements.
 *
 * Declared in `ownership.ts` alongside the product projection, because the two have to agree
 * and keeping them in one file is what makes disagreement visible. Read there for why the
 * list is deliberately narrower than `^craft_(wiki|knowledge)`.
 */
export { KNOWLEDGE_OWNS };

export const knowledgeCapability: CraftCapability = {
  name: "knowledge",
  product: "craft-knowledge",
  evaluation: { input_contract: "scoped-query-or-claim", output_contract: "evidence-backed-knowledge", fixture_id: "knowledge-fixture-v1", host_compatibility: ["fixture", "codex", "claude"] },
  owns: KNOWLEDGE_OWNS,
  /**
   * Assemble the registered kernels from the store the core already opened.
   *
   * Nothing here reads a settings file or a path: a capability that resolved its own
   * environment could not be replaced by a differently configured one.
   */
  register(registry): void {
    const store = registry.require<CraftStore>(CORE_KERNELS.store);
    // The Source registry is this member's, now that it no longer shares a class with the
    // Memory Ledger. Its tools become the capability's to claim rather than the core's to
    // project on its behalf, which is the whole point of cutting the class along the member.
    registry.provide(KNOWLEDGE_KERNELS.claims, new KnowledgeClaimGovernance(store));
    registry.provide(KNOWLEDGE_KERNELS.sources, new KnowledgeSourceRegistry(store));
    registry.provide(KNOWLEDGE_KERNELS.workbench, new KnowledgeWorkbenchKernel(store));
    registry.provide(KNOWLEDGE_KERNELS.boundLaunch, new KnowledgeBoundLaunchKernel(store));
    registry.provide(KNOWLEDGE_KERNELS.relations, new KnowledgeRelationKernel(store));
    registry.provide(KNOWLEDGE_KERNELS.wikiCandidates, new WikiCandidateGovernanceKernel(store));
    registry.provide(KNOWLEDGE_KERNELS.localImport, new LocalCandidateImportKernel(store));
    registry.provide(KNOWLEDGE_KERNELS.projectKnowledge, new ProjectKnowledgeKernel(store));
    registry.provide(KNOWLEDGE_KERNELS.projectBrain, new ProjectBrainKernel(store));
  },
  contributes: (registry) => new KnowledgeContribution(registry.require<CraftStore>(CORE_KERNELS.store)),
};
