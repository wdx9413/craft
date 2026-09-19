/**
 * The Knowledge capability.
 *
 * Knowledge is the accumulated context member gated by Evidence: a saved Claim carries the
 * Evidence that backs it, and a Wiki page carries the claim identity rather than a copy of it.
 * That gate is why this member is a capability and not a convenience store.
 *
 * The package owns seven kernels and nothing else:
 *
 * | kernel | what it holds |
 * |---|---|
 * | `knowledge-workbench` | the bounded read-only Workbench projection and a Context Bundle preview |
 * | `knowledge-bound-launch` | a Work Launch pinned to one exact Context Bundle, revalidated before any Host run |
 * | `knowledge-relation` | typed, evidence-backed relations between addressable knowledge objects |
 * | `wiki-candidate-governance` | attestation, publication authorization and portable package preparation |
 * | `local-candidate-import` | writing one reviewed package to a user-selected path, without executing it |
 * | `project-knowledge` | the rebuildable Markdown index projection, its search and its scope expiry |
 * | `project-brain` | the project's goals, decisions, bound material and recorded outcomes |
 *
 * Two things it deliberately does **not** own: the Knowledge Source registry
 * (`knowledge-memory-runtime.ts`, which serves memory's writes too, so it stays in the core),
 * and the claim and Wiki page write verbs, which still live in the `craft-service.ts` facade.
 * Both are named in `ownership.ts` where the projection is declared, because the product must
 * still expose them even though this package does not implement them.
 *
 * Like Experience, it declares no `contributes`. The read side of knowledge exists as tools
 * (`craft_wiki_context_compile`, `craft_knowledge_workbench_view`) but not as a
 * `ContextContributionProvider`, and inventing one that no caller invokes would be a claim
 * with no user. Recorded here so the absence is visible where a reader would look for it.
 */
import type { CraftCapability } from "../../src/capability-protocol.ts";
import { CORE_KERNELS } from "../../src/capability-protocol.ts";
import type { CraftStore } from "../../src/infrastructure/store.ts";
import { KnowledgeBoundLaunchKernel } from "./knowledge-bound-launch.ts";
import { KnowledgeRelationKernel } from "./knowledge-relation.ts";
import { KnowledgeSourceRegistry } from "./knowledge-source-registry.ts";
import { KnowledgeWorkbenchKernel } from "./knowledge-workbench.ts";
import { LocalCandidateImportKernel } from "./local-candidate-import.ts";
import { KNOWLEDGE_OWNS } from "./ownership.ts";
import { ProjectBrainKernel } from "./project-brain.ts";
import { ProjectKnowledgeKernel } from "./project-knowledge.ts";
import { WikiCandidateGovernanceKernel } from "./wiki-candidate-governance.ts";

/**
 * Kernel names this capability registers, and the core requires back.
 *
 * Namespaced for the same reason as Experience: two capabilities cannot both provide a bare
 * `workbench` and neither has to know the other exists to avoid the collision.
 */
export const KNOWLEDGE_KERNELS = {
  sources: "knowledge.sources",
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
  owns: KNOWLEDGE_OWNS,
  /**
   * Assemble the seven kernels from the store the core already opened.
   *
   * Nothing here reads a settings file or a path: a capability that resolved its own
   * environment could not be replaced by a differently configured one.
   */
  register(registry): void {
    const store = registry.require<CraftStore>(CORE_KERNELS.store);
    // The Source registry is this member's, now that it no longer shares a class with the
    // Memory Ledger. Its tools become the capability's to claim rather than the core's to
    // project on its behalf, which is the whole point of cutting the class along the member.
    registry.provide(KNOWLEDGE_KERNELS.sources, new KnowledgeSourceRegistry(store));
    registry.provide(KNOWLEDGE_KERNELS.workbench, new KnowledgeWorkbenchKernel(store));
    registry.provide(KNOWLEDGE_KERNELS.boundLaunch, new KnowledgeBoundLaunchKernel(store));
    registry.provide(KNOWLEDGE_KERNELS.relations, new KnowledgeRelationKernel(store));
    registry.provide(KNOWLEDGE_KERNELS.wikiCandidates, new WikiCandidateGovernanceKernel(store));
    registry.provide(KNOWLEDGE_KERNELS.localImport, new LocalCandidateImportKernel(store));
    registry.provide(KNOWLEDGE_KERNELS.projectKnowledge, new ProjectKnowledgeKernel(store));
    registry.provide(KNOWLEDGE_KERNELS.projectBrain, new ProjectBrainKernel(store));
  },
};
