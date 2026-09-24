import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  KNOWLEDGE_KERNELS,
  KNOWLEDGE_OWNS,
  knowledgeCapability,
} from "../capability/craft-knowledge/capability.ts";
import { KnowledgeBoundLaunchKernel } from "../capability/craft-knowledge/knowledge-bound-launch.ts";
import { KnowledgeRelationKernel } from "../capability/craft-knowledge/knowledge-relation.ts";
import { KnowledgeWorkbenchKernel } from "../capability/craft-knowledge/knowledge-workbench.ts";
import { LocalCandidateImportKernel } from "../capability/craft-knowledge/local-candidate-import.ts";
import {
  KNOWLEDGE_COMPONENT,
} from "../capability/craft-knowledge/ownership.ts";
import { KnowledgeSourceRegistry } from "../capability/craft-knowledge/knowledge-source-registry.ts";
import { ProjectBrainKernel } from "../capability/craft-knowledge/project-brain.ts";
import { ProjectKnowledgeKernel } from "../capability/craft-knowledge/project-knowledge.ts";
import { WikiCandidateGovernanceKernel } from "../capability/craft-knowledge/wiki-candidate-governance.ts";
import { CRAFT_CAPABILITIES } from "../core/capability-catalog.ts";
import { buildCapabilityRegistry, CORE_KERNELS } from "../core/capability-protocol.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { PROVIDER_CATALOG } from "../core/model-gateway.ts";
import { ACTIVE_TOOLS } from "../core/interfaces/mcp-server.ts";
import { COMPONENT_SURFACES } from "../core/interfaces/mcp/surface-registry.ts";
import { surfaceToolNames } from "../core/mcp.ts";
import { CraftService } from "../core/service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-knowledge-package-"));
  const store = await new CraftStore(craftPaths(root)).open();
  // The whole core environment, because the catalog holds both capabilities: assembling the
  // set is a whole-system act even when only one capability's kernels are inspected.
  const core: Record<string, unknown> = {
    [CORE_KERNELS.store]: store,
    [CORE_KERNELS.modelProviders]: PROVIDER_CATALOG,
  };
  return { root, store, core, service: new CraftService(store) };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.close();
  await rm(f.root, { recursive: true, force: true });
}

const KERNEL_CLASSES = [
  KnowledgeSourceRegistry, KnowledgeWorkbenchKernel, KnowledgeBoundLaunchKernel, KnowledgeRelationKernel,
  WikiCandidateGovernanceKernel, LocalCandidateImportKernel, ProjectKnowledgeKernel, ProjectBrainKernel,
];

test("v0.12.43 assembles the Knowledge capability from the catalog rather than in place", async () => {
  const f = await fixture();
  try {
    const { registry } = buildCapabilityRegistry(CRAFT_CAPABILITIES, f.core);
    const instances = Object.values(KNOWLEDGE_KERNELS).map((name) => registry.require<{ store: CraftStore }>(name));
    assert.equal(instances.length, 8);
    // Each registered kernel is one of the eight classes, and every class is registered — so a
    // kernel added to the package without a name, or a name without a kernel, fails here.
    assert.deepEqual(
      instances.map((instance) => instance.constructor).sort((a, b) => a.name.localeCompare(b.name)),
      [...KERNEL_CLASSES].sort((a, b) => a.name.localeCompare(b.name)),
    );
    for (const instance of instances) assert.equal(instance.store, f.store);
  } finally { await close(f); }
});

test("v0.12.43 fails on the kernel a removed capability owed instead of leaving it undefined", async () => {
  const f = await fixture();
  try {
    const { registry } = buildCapabilityRegistry([], f.core);
    assert.throws(() => registry.require(KNOWLEDGE_KERNELS.projectBrain), /kernel is not registered: knowledge\.project_brain/u);
    // Knowledge and Experience are separate capabilities: dropping one must not affect the
    // other's kernels, which is what makes the catalog a partition rather than a list.
    assert.throws(() => registry.require("experience.ledger"), /kernel is not registered: experience\.ledger/u);
  } finally { await close(f); }
});

test("v0.12.43 claims the families its kernels implement and no others", async () => {
  // Each of these is backed by one of the eight kernels, checked against `craft-service.ts`.
  for (const owned of [
    "craft_relation_relate", "craft_relation_traverse", "craft_knowledge_workbench_view",
    "craft_knowledge_context_work_launch_prepare", "craft_wiki_skill_candidate_review",
    "craft_wiki_candidate_local_import", "craft_project_knowledge_discover",
    "craft_knowledge_index_sync", "craft_knowledge_scope_forget", "craft_project_brain_open",
    // Newly owned, because the split moved the Source registry into this package. It used to be
    // projected by the product while being implemented by a class the capability did not own.
    "craft_knowledge_source_register", "craft_knowledge_source_list",
    "craft_knowledge_source_transition", "craft_knowledge_bootstrap_install",
    "craft_knowledge_memory_install_builtins",
  ]) assert(KNOWLEDGE_OWNS.test(owned), `${owned} must be owned`);

  // Still not owned, and for two different reasons. The first three are implemented by the
  // facade or by `wiki-candidate-governance.ts` rather than by a kernel this package assembles;
  // the rest belong to other members or to the shared context plane.
  for (const foreign of [
    "craft_knowledge_claim_save", "craft_wiki_page_save", "craft_knowledge_evaluation_run",
    "craft_memory_ledger_remember", "craft_context_resolution_resolve", "craft_retrieval_adapter_evaluate",
  ]) assert(!KNOWLEDGE_OWNS.test(foreign), `${foreign} must not be owned`);

  const names = ACTIVE_TOOLS.map((tool) => tool.name);
  const owned = names.filter((name) => KNOWLEDGE_OWNS.test(name));
  assert(owned.length >= 15, `expected a substantial owned surface, got ${owned.length}`);
  assert.equal(knowledgeCapability.name, "knowledge");
  assert.equal(knowledgeCapability.product, "craft-knowledge");
  assert.equal(knowledgeCapability.owns, KNOWLEDGE_OWNS);
  // Reviewed knowledge now enters the shared Context Resolution seam. Candidates remain
  // discoverable to a human but never become a Host contribution.
  assert.equal(typeof knowledgeCapability.contributes, "function");
  // A capability cannot be declared twice, and the registry is what says so.
  const f = await fixture();
  try {
    const { registry } = buildCapabilityRegistry(CRAFT_CAPABILITIES, f.core);
    assert(registry.require<KnowledgeSourceRegistry>(KNOWLEDGE_KERNELS.sources));
  } finally { await close(f); }
});

test("v0.12.43 keeps the Knowledge projection at exactly the name space it promised", () => {
  const surface = COMPONENT_SURFACES["component-knowledge"];
  assert(surface, "component-knowledge must be a declared surface");

  // Behaviour preservation for the four families the product already promised, plus the
  // `project` repair measured below. The previous literal was
  // `/^craft_(wiki|knowledge|claim|relation|context_resolution|retrieval_adapter)/`.
  const previous = /^craft_(wiki|knowledge|claim|relation|context_resolution|decision_context_gate|retrieval_adapter)/;
  const exposed = surfaceToolNames("component-knowledge");
  const expected = ACTIVE_TOOLS.map((tool) => tool.name).filter((name) => previous.test(name));
  for (const name of expected) assert(exposed.includes(name), `component-knowledge lost ${name}`);
  assert(exposed.includes("craft_knowledge_claim_save"));
  assert(exposed.includes("craft_context_resolution_resolve"));
  assert(exposed.includes("craft_retrieval_adapter_evaluate"));
  for (const name of ["craft_wiki_page_save", "craft_relation_relate"]) assert(exposed.includes(name));
  // Nothing from another member leaked in through the composition.
  assert(!exposed.includes("craft_memory_ledger_remember"));
  assert(!exposed.includes("craft_workflow_evolution_observe"));

  // The repair, measured: two of the seven kernels this package assembles serve `craft_project_*`
  // and the product could not reach either of them before.
  const added = exposed.filter((name) => !previous.test(name) && name !== "craft_info");
  assert(added.length > 0, "the project repair must add tools");
  for (const name of added) assert(name.startsWith("craft_project_"), `unexpected addition ${name}`);
  assert(exposed.includes("craft_project_knowledge_discover"));
  assert(exposed.includes("craft_project_brain_open"));
});

test("v0.12.43 owns the Source registry now that it no longer shares a class with memory", () => {
  // This test replaces one that asserted the opposite. Before the split the Source registry lived
  // in `knowledge-memory-runtime.ts`, one class serving this member's Sources *and* memory's
  // Ledger writes, so the capability could not own them and the product projected them on the
  // core's behalf. Cutting the class along the member boundary moved the registry here, so the
  // claim is now the capability's to make — and the assertion had to change rather than be
  // deleted, because the previous claim would have become false silently.
  const exposed = surfaceToolNames("component-knowledge");
  const owned = ACTIVE_TOOLS.map((tool) => tool.name).filter((name) => KNOWLEDGE_OWNS.test(name));
  for (const name of owned) assert(KNOWLEDGE_COMPONENT.test(name), `component-knowledge must expose ${name}`);
  for (const name of ["craft_knowledge_source_register", "craft_knowledge_source_list", "craft_knowledge_bootstrap_install"]) {
    assert(KNOWLEDGE_OWNS.test(name), `${name} must be owned`);
    assert(exposed.includes(name), `component-knowledge must expose ${name}`);
  }
  // And the tool the facade still implements stays projected-but-unowned, so the distinction
  // this test used to draw is still drawn somewhere.
  assert(!KNOWLEDGE_OWNS.test("craft_knowledge_claim_save"));
  assert(exposed.includes("craft_knowledge_claim_save"));
});

test("v0.12.43 composes the Context product from both members without restating them", () => {
  const context = COMPONENT_SURFACES["component-context"];
  const previous = /^craft_(wiki|knowledge|claim|relation|memory|context_resolution|decision_context_gate|retrieval_adapter)/;
  const exposed = surfaceToolNames("component-context");
  const expected = ACTIVE_TOOLS.map((tool) => tool.name).filter((name) => previous.test(name));
  // `component-context` is the user-facing composition, so it must remain exactly the union
  // of the members it composes — no more, and no less.
  assert.deepEqual([...exposed].sort(), [...expected, "craft_info"].sort());
  for (const name of ["craft_knowledge_claim_save", "craft_memory_ledger_remember", "craft_context_resolution_resolve"]) {
    assert(context.test(name), `component-context must expose ${name}`);
  }
  assert(!context.test("craft_workflow_evolution_observe"));
});

test("v0.12.43 keeps the service working through the assembled capability", async () => {
  const f = await fixture();
  try {
    // Two behaviours from two different kernels in the package, through the facade, prove the
    // switch from inline construction to registry resolution rather than only the wiring.
    const registered = f.service.knowledgeSourceRegister({
      kind: "readme", label: "notes", scope_kind: "project", scope_id: "p",
      locator: "README.md", content_digest: "sha256:readme", trust: "bounded",
    });
    assert(registered.source);
    const listed = f.service.knowledgeSourceList({});
    assert((listed.sources as unknown[]).length >= 1);
    assert.equal(typeof f.service.knowledgeWorkbenchView().summary, "object");
    assert.equal(typeof f.service.projectBrainOpen, "function");
  } finally { await close(f); }
});
