import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { MEMORY_KERNELS, MEMORY_OWNS, memoryCapability } from "../capability/craft-memory/capability.ts";
import { MemoryLedgerKernel } from "../capability/craft-memory/memory-ledger.ts";
import { MemorySignalsKernel } from "../capability/craft-memory/memory-signals-kernel.ts";
import { MEMORY_COMPONENT, MEMORY_CONTEXT_SOURCE } from "../capability/craft-memory/ownership.ts";
import { KnowledgeSourceRegistry } from "../capability/craft-knowledge/knowledge-source-registry.ts";
import { CRAFT_CAPABILITIES } from "../src/capability-catalog.ts";
import { buildCapabilityRegistry, CORE_KERNELS } from "../src/capability-protocol.ts";
import { ContextResolutionKernel } from "../src/context-resolution.ts";
import { CraftStore } from "../src/infrastructure/store.ts";
import { craftPaths } from "../src/infrastructure/paths.ts";
import { ACTIVE_TOOLS } from "../src/interfaces/mcp-server.ts";
import { COMPONENT_SURFACES } from "../src/interfaces/mcp/surface-registry.ts";
import { surfaceToolNames } from "../src/mcp.ts";
import { PROVIDER_CATALOG } from "../src/model-gateway.ts";
import { CraftService } from "../src/service.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-memory-package-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const core: Record<string, unknown> = {
    [CORE_KERNELS.store]: store,
    [CORE_KERNELS.modelProviders]: PROVIDER_CATALOG,
  };
  // A Ledger entry cannot exist without the Source it cites and the Evidence that backs it, so
  // the environment has to provide both before the capability is worth exercising.
  const sources = new KnowledgeSourceRegistry(store);
  const source = sources.sourceRegister({
    source_id: "src", kind: "project_note", label: "notes", scope_kind: "project", scope_id: "p",
    locator: "notes.md", content_digest: "sha256:notes", trust: "verified", access: "proposal_only",
  }).source as { id: string };
  store.create("evidence", "confirmed", { confidence: "confirmed" });
  return { root, store, core, sourceId: String(source.id), service: new CraftService(store) };
}
async function close(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.close();
  await rm(f.root, { recursive: true, force: true });
}

test("v0.12.43 assembles the Memory capability from the catalog rather than in place", async () => {
  const f = await fixture();
  try {
    const { registry } = buildCapabilityRegistry(CRAFT_CAPABILITIES, f.core);
    const ledger = registry.require<MemoryLedgerKernel>(MEMORY_KERNELS.ledger);
    assert(ledger instanceof MemoryLedgerKernel);
    const signals = registry.require<MemorySignalsKernel>(MEMORY_KERNELS.signals);
    assert(signals instanceof MemorySignalsKernel);
    assert.equal(signals.store, f.store);
    assert.equal(ledger.store, f.store);
    // Two kernels: the Ledger's writes and the signals derived from recall history. The count is
    // the check that the package grows deliberately rather than by accumulation.
    assert.deepEqual(Object.values(MEMORY_KERNELS).sort(), ["memory.ledger", "memory.signals"]);
  } finally { await close(f); }
});

test("v0.12.43 fails on the kernel a removed capability owed instead of leaving it undefined", async () => {
  const f = await fixture();
  try {
    const { registry } = buildCapabilityRegistry([], f.core);
    assert.throws(() => registry.require(MEMORY_KERNELS.ledger), /kernel is not registered: memory\.ledger/u);
    // The three members are separate capabilities: dropping memory must not disturb the other
    // two, which is what makes the catalog a set of packages rather than one program.
    assert.throws(() => registry.require("knowledge.sources"), /kernel is not registered/u);
    assert.throws(() => registry.require("experience.ledger"), /kernel is not registered/u);
  } finally { await close(f); }
});

test("v0.12.43 claims the Ledger's scoped reads and writes, the derived signals, and nothing else", async () => {
  for (const owned of [
    "craft_memory_ledger_remember", "craft_memory_ledger_get", "craft_memory_ledger_list", "craft_memory_ledger_transition", "craft_memory_ledger_compat_bind",
    // The derived signals are owned because `src/memory-wiring.ts` moved into this package as
    // `memory-signals.ts`. Claiming them needed no behaviour change, only the file move — which is
    // the difference between an ownership declaration and an aspiration.
    "craft_memory_decay_get", "craft_memory_hybrid_scores", "craft_memory_usage_record",
    "craft_memory_capture_propose", "craft_memory_promotion_preview",
  ]) assert(MEMORY_OWNS.test(owned), `${owned} must be owned`);

  // A correction, asserted so it cannot regress: an earlier version of `MEMORY_OWNS` claimed
  // `craft_memory_remember` and `craft_memory_transition` as "the Ledger's older names", and this
  // test asserted that. Both are actually served by `WorkbenchKernel` over the legacy
  // `memory_item` collection, which this package does not assemble. A declaration that is merely
  // plausible is exactly what the ownership pattern exists to catch.
  for (const foreign of [
    "craft_memory_remember", "craft_memory_transition",
    "craft_context_resolution_resolve", "craft_retrieval_adapter_evaluate",
    "craft_memory_consolidate", "craft_memory_resolve", "craft_memory_search", "craft_memory_remember_episode",
    "craft_knowledge_source_list",
  ]) assert(!MEMORY_OWNS.test(foreign), `${foreign} must not be owned`);

  // The two verbs it must not claim really do exist and really are served elsewhere, so the
  // exclusion is a boundary rather than an absence.
  const names = ACTIVE_TOOLS.map((tool) => tool.name);
  for (const name of ["craft_memory_remember", "craft_memory_transition", "craft_memory_consolidate"]) {
    assert(names.includes(name), `${name} must exist in the catalog`);
    assert(!MEMORY_OWNS.test(name));
  }

  assert.deepEqual(names.filter((name) => MEMORY_OWNS.test(name)).sort(), [
    "craft_memory_capture_propose", "craft_memory_decay_get", "craft_memory_hybrid_scores",
    "craft_memory_ledger_compat_bind", "craft_memory_ledger_get", "craft_memory_ledger_list", "craft_memory_ledger_remember", "craft_memory_ledger_transition",
    "craft_memory_promotion_preview", "craft_memory_usage_record",
  ]);
  assert.equal(memoryCapability.name, "memory");
  assert.equal(memoryCapability.product, "craft-memory");
  assert.equal(memoryCapability.owns, MEMORY_OWNS);
  // The read side is `ContextResolutionKernel`, which is in the core and therefore not this
  // capability's to contribute. Declaring one here would give the member two contributors, which
  // the registry rejects outright.
  assert.equal(memoryCapability.contributes, undefined);
});

test("v0.12.43 keeps the Memory projection at the name space it promised, and repairs one name", () => {
  const surface = COMPONENT_SURFACES["component-memory"];
  assert(surface, "component-memory must be a declared surface");

  // Behaviour preservation against the literal this replaced:
  // `/^craft_(memory|knowledge_source|knowledge_bootstrap|context_resolution|retrieval_adapter)/`.
  const previous = /^craft_(memory|knowledge_source|knowledge_bootstrap|context_resolution|decision_context_gate|retrieval_adapter)/;
  const exposed = surfaceToolNames("component-memory");
  for (const name of ACTIVE_TOOLS.map((tool) => tool.name).filter((name) => previous.test(name))) {
    assert(exposed.includes(name), `component-memory lost ${name}`);
  }
  assert(exposed.includes("craft_memory_ledger_remember"));
  assert(exposed.includes("craft_memory_consolidate"));
  assert(exposed.includes("craft_context_resolution_resolve"));
  assert(exposed.includes("craft_knowledge_source_list"));
  // Nothing from another member leaked in.
  assert(!exposed.includes("craft_wiki_page_save"));
  assert(!exposed.includes("craft_workflow_evolution_observe"));

  // The repair, measured: `craft_knowledge_memory_install_builtins` is the same handler as
  // `craft_knowledge_bootstrap_install` under an older name. The old literal matched the newer
  // alias but not the older one, so a Host could bootstrap through one name and not the other.
  const added = exposed.filter((name) => !previous.test(name) && name !== "craft_info");
  assert.deepEqual(added, ["craft_knowledge_memory_install_builtins"]);
  assert(surface.test("craft_knowledge_memory_install_builtins"));
});

test("v0.12.43 keeps component-context composing the frozen memory name space", () => {
  const context = COMPONENT_SURFACES["component-context"];
  const previous = /^craft_(wiki|knowledge|claim|relation|memory|context_resolution|decision_context_gate|retrieval_adapter)/;
  const exposed = surfaceToolNames("component-context");
  const expected = ACTIVE_TOOLS.map((tool) => tool.name).filter((name) => previous.test(name));
  // `component-context` is a compatibility surface: the split must not change what an existing
  // Host sees through it, which is why it composes the *frozen* name space rather than the
  // memory product's.
  assert.deepEqual([...exposed].sort(), [...expected, "craft_info"].sort());
  assert(MEMORY_CONTEXT_SOURCE === "craft_memory");
  for (const name of ["craft_memory_ledger_remember", "craft_knowledge_claim_save", "craft_context_resolution_resolve"]) {
    assert(context.test(name), `component-context must expose ${name}`);
  }
});

test("v0.12.43 exposes every signal through the registered kernel, not only through the module", async () => {
  const f = await fixture();
  try {
    const { registry } = buildCapabilityRegistry(CRAFT_CAPABILITIES, f.core);
    const signals = registry.require<MemorySignalsKernel>(MEMORY_KERNELS.signals);
    // Every method, because the kernel is the surface the registry hands out: a signal reachable
    // only by importing the module is a signal no capability consumer can reach. The functions
    // themselves are covered by `tests/memory-wiring.test.ts`; what this asserts is the delegation.
    const weight = signals.decayWeight({
      confirmed_at: "2026-01-01T00:00:00.000Z", now: "2026-01-02T00:00:00.000Z", accesses: 0, trust: "verified",
    });
    assert.equal(typeof weight, "number");
    assert.deepEqual(
      signals.rankWithDecay([{ id: "a", base_score: 1, decay: 1 }, { id: "b", base_score: 2, decay: 0.1 }]).map((item) => item.id),
      ["a", "b"],
    );
    assert.equal(typeof signals.shouldPropose({ outcome: "succeeded" }).propose, "boolean");
    assert.equal(typeof signals.planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "l", content: "legacy note" }).legacy_kind, "string");
    assert.deepEqual(signals.hybridScores([{ id: "m", similarity: 0.9, keyword_score: 1 }], { vectorEligible: false }), [{ id: "m", score: 1, retrieval_mode: "keyword" }]);
    assert.equal(typeof signals.usageEvidence({ memory_ids: ["m"], outcome: "succeeded", turn_id: "t1" }).counted_as_use, "boolean");
  } finally { await close(f); }
});

test("v0.12.43 keeps the ledger closed without a Source and keeps the facade working", async () => {
  const f = await fixture();
  try {
    // Provenance is mandatory: the Source must exist and be active.
    assert.throws(() => f.service.memoryLedgerRemember({
      kind: "working", scope_kind: "project", scope_id: "p", content: "x", source_id: "missing",
    }), /knowledge_source/);
    const remembered = f.service.memoryLedgerRemember({
      memory_id: "m1", source_id: f.sourceId, kind: "working", scope_kind: "project", scope_id: "p",
      content: "Prefers bounded receipts", sensitivity: "internal",
    });
    assert((remembered.memory as { id: string }).id === "m1");
    // A procedural or confirmed entry needs Evidence, which is the gate that distinguishes this
    // member from an unstructured note store.
    assert.throws(() => f.service.memoryLedgerRemember({
      source_id: f.sourceId, kind: "procedural", scope_kind: "project", scope_id: "p", content: "x",
    }), /requires Evidence/);
    // The read side is the core context plane, reached through the same facade.
    const resolved = await f.service.contextResolutionResolve({ query: "receipts", scope_kind: "project", scope_id: "p" });
    assert((resolved.items as unknown[]).length === 1);
    assert.equal((resolved.receipt as { content_free: boolean }).content_free, true);
    // And the bootstrap verbs still work through both of their names.
    assert((f.service.knowledgeMemoryInstallBuiltins().sources as unknown[]).length === 2);
  } finally { await close(f); }
});

test("v0.12.43 resolves memory through a kernel in the core, not through either member's package", async () => {
  const f = await fixture();
  try {
    const context = new ContextResolutionKernel(f.store);
    f.store.create("memory_ledger", "m2", {
      source_id: f.sourceId, source_version: 1, kind: "working", scope: { kind: "project", id: "p" },
      content: "keyword match", content_digest: "sha256:c", sensitivity: "internal", confidence: "bounded",
      evidence_ids: [], valid_until: null, status: "active", supersedes_id: null,
    });
    const resolved = await context.resolve({ query: "keyword", scope_kind: "project", scope_id: "p" });
    assert((resolved.items as unknown[]).length === 1);
    // The core class is what both products project, so it is reachable without either package.
    assert.equal(MEMORY_OWNS.test("craft_context_resolution_resolve"), false);
  } finally { await close(f); }
});
