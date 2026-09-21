import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  EXPERIENCE_KERNELS,
  EXPERIENCE_OWNS,
  experienceCapability,
} from "../capability/craft-experience/capability.ts";
import { EvaluationModelProfileKernel } from "../capability/craft-experience/evaluation-model-profile.ts";
import { ExperienceLedgerKernel } from "../capability/craft-experience/experience-ledger.ts";
import { WorkflowEvolutionKernel } from "../capability/craft-experience/workflow-evolution.ts";
import { CRAFT_CAPABILITIES } from "../src/capability-catalog.ts";
import { buildCapabilityRegistry, CORE_KERNELS, type CraftCapability } from "../src/capability-protocol.ts";
import { CraftStore } from "../src/infrastructure/store.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { PROVIDER_CATALOG } from "../src/model-gateway.ts";
import { CraftService } from "../src/service.ts";
import { ACTIVE_TOOLS } from "../src/interfaces/mcp-server.ts";
import { surfaceToolNames } from "../src/mcp.ts";
import { COMPONENT_SURFACES } from "../src/interfaces/mcp/surface-registry.ts";

/** The environment the core contributes, i.e. everything a capability is allowed to require. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-package-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const core: Record<string, unknown> = {
    [CORE_KERNELS.store]: store,
    [CORE_KERNELS.modelProviders]: PROVIDER_CATALOG,
  };
  // The ledger only accepts a reference that resolves, so the source and its Evidence exist
  // before the capability is assembled — the same precondition the core would have.
  store.create("outcome", "outcome", { verdict: "succeeded" });
  store.create("evidence", "confirmed", { confidence: "confirmed" });
  return { root, store, core, service: new CraftService(store) };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.close();
  await rm(f.root, { recursive: true, force: true });
}

test("v0.12.43 assembles the Experience capability from the catalog rather than in place", async () => {
  const f = await fixture();
  try {
    const { registry } = buildCapabilityRegistry(CRAFT_CAPABILITIES, f.core);
    const ledger = registry.require<ExperienceLedgerKernel>(EXPERIENCE_KERNELS.ledger);
    const evolution = registry.require<WorkflowEvolutionKernel>(EXPERIENCE_KERNELS.workflowEvolution);
    const profiles = registry.require<EvaluationModelProfileKernel>(EXPERIENCE_KERNELS.modelProfiles);
    assert(ledger instanceof ExperienceLedgerKernel);
    assert(evolution instanceof WorkflowEvolutionKernel);
    assert(profiles instanceof EvaluationModelProfileKernel);
    // The capability was handed the core's store rather than opening its own.
    assert.equal(ledger.store, f.store);
  } finally { await close(f); }
});

test("v0.12.43 fails on the kernel a removed capability owed instead of leaving it undefined", async () => {
  const f = await fixture();
  try {
    // The property the contract exists for: a capability cannot be omitted silently.
    const { registry } = buildCapabilityRegistry([], f.core);
    assert.throws(() => registry.require(EXPERIENCE_KERNELS.ledger), /kernel is not registered: experience\.ledger/u);
    // The core's own kernels survive, so the failure names the capability rather than the
    // environment the capability would have used.
    assert(f.core[CORE_KERNELS.store]);
    assert.equal(registry.optional(EXPERIENCE_KERNELS.ledger), undefined);
  } finally { await close(f); }
});

test("v0.12.43 refuses a capability that tries to provide the environment it runs in", async () => {
  const f = await fixture();
  try {
    const intruder: CraftCapability = {
      name: "intruder",
      owns: /^craft_intruder_/u,
      register: (registry) => registry.provide(CORE_KERNELS.store, "not-a-store"),
    };
    // The core seeds the registry first, so a capability cannot displace the store. Colliding
    // is an assembly failure rather than last-writer-wins, and the message names the kernel.
    assert.throws(() => buildCapabilityRegistry([intruder], f.core), /kernel already registered: core\.store/u);
  } finally { await close(f); }
});

test("v0.12.43 claims the tool families its kernels implement and no others", async () => {
  const f = await fixture();
  // Every alternative here is served by one of the three kernels. The list is deliberately not
  // `^craft_experience_`: `craft_experience_mine`, `craft_experience_pattern_*`,
  // `craft_experience_candidate_list`, `craft_experience_shadow_experiment_*` and
  // `craft_experience_capture_*` are kernels this capability does not assemble, so claiming
  // them would be a false statement about ownership.
  for (const owned of [
    "craft_experience_ledger_observe", "craft_experience_procedure_draft",
    "craft_evaluation_model_profile_save", "craft_route_workflow_proposal", "craft_workflow_rollback",
  ]) assert(EXPERIENCE_OWNS.test(owned), `${owned} must be owned`);

  for (const foreign of [
    "craft_experience_mine", "craft_experience_pattern_list",
    "craft_experience_candidate_list", "craft_experience_capture_decide",
  ]) assert(!EXPERIENCE_OWNS.test(foreign), `${foreign} must not be owned`);

  // Ownership is a claim about a real catalog, not a pattern that merely looks plausible: a
  // rename that leaves the regex behind is reported instead of tolerated.
  const names = ACTIVE_TOOLS.map((tool) => tool.name);
  assert(names.filter((name) => EXPERIENCE_OWNS.test(name)).length > 0);
  assert.equal(experienceCapability.name, "experience");
  assert.equal(experienceCapability.product, "craft-experience");
  assert.equal(experienceCapability.owns, EXPERIENCE_OWNS);
  // The read side exists now, and this assertion replaces one that said it did not. Experience is
  // the only one of the three members with a contribution, because it is the only one whose records
  // a Host must not read directly: knowledge and memory are resolved through the core plane, while
  // experience is `execution_visible: false` and content-free, so all it can contribute is *which*
  // compiled experience applies.
  assert.equal(typeof experienceCapability.contributes, "function");
  const { registry } = buildCapabilityRegistry(CRAFT_CAPABILITIES, f.core);
  const contribution = experienceCapability.contributes!(registry);
  assert.equal(contribution.member, "experience");
  const empty = await contribution.contribute({ query: "nothing", scope_kind: "project", scope_id: "p", max_items: 5, max_chars: 500 });
  assert.deepEqual(empty.items, []);
  assert.equal(empty.omitted_count, 0);
  await close(f);
});

test("v0.12.43 derives the component surface from the capability so the two cannot drift", () => {
  // `COMPONENT_SURFACES` is a projection and `owns` is ownership. The projection may be wider
  // — it adds the context tools a Host needs to resolve what the capability stored — but never
  // narrower, because then a tool the capability exposes would be unreachable through the very
  // product that exists to expose it.
  const surface = COMPONENT_SURFACES["component-experience"];
  assert(surface, "component-experience must be a declared surface");
  const owned = ACTIVE_TOOLS.map((tool) => tool.name).filter((name) => EXPERIENCE_OWNS.test(name));
  for (const name of owned) assert(surface.test(name), `component-experience must expose ${name}`);

  // Measured, and the number is the point: the surface used to be the literal
  // `experience_mine|experience_candidate|experience_shadow`, which does not match
  // `craft_experience_ledger_*` at all, so the ledger was unreachable through the product
  // named after it. Deriving the surface from `owns` adds those tools back.
  const exposed = surfaceToolNames("component-experience");
  for (const name of ["craft_experience_ledger_observe", "craft_experience_ledger_compile", "craft_experience_ledger_decide"]) {
    assert(exposed.includes(name), `component-experience must expose ${name}`);
  }
  assert(owned.length >= 3);
});

test("v0.12.43 keeps the service working through the assembled capability", async () => {
  const f = await fixture();
  try {
    // The facade still exposes the three kernels, now resolved from the registry rather than
    // constructed in place. Going through a behaviour proves the switch, not just the wiring.
    const observed = f.service.experienceLedgerObserve({
      source_ref: { kind: "outcome", id: "outcome", version: 1 }, kind: "success", scenario_key: "s",
      finding: "it worked", evidence_ids: ["confirmed"],
    });
    assert(observed.observation);
    assert.equal(typeof f.service.workflowEvolutionObserve, "function");
    assert.equal(typeof f.service.evaluationModelProfileSave, "function");
  } finally { await close(f); }
});
