import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { HookPlane } from "../core/hook-plane.ts";
import { ownerOfTool } from "../core/capability-catalog.ts";
import { buildCapabilityRegistry, CORE_KERNELS, type CraftCapability, type Hook, type HookContext } from "../core/capability-protocol.ts";
import { CRAFT_CAPABILITIES } from "../core/capability-catalog.ts";
import { CraftStore } from "../core/infrastructure/store.ts";
import { craftPaths } from "../core/infrastructure/paths.ts";
import { PROVIDER_CATALOG } from "../core/model-gateway.ts";
import { CraftService } from "../core/service.ts";
import { McpServer } from "../core/mcp.ts";

/**
 * The hook plane's real call site, and the three pieces of instrumentation the protocol owed.
 *
 * `runPhase` had eighteen tests and **no caller**, so "a hook can stop a tool call" was a claim
 * nothing exercised end to end. These tests go through `McpServer.handle` — the actual entry a
 * Host uses — so a refusal has to travel the whole way to be believed.
 */

async function fixture(hooks: readonly Hook[] = []) {
  const root = await mkdtemp(join(tmpdir(), "craft-hook-plane-"));
  const store = await new CraftStore(craftPaths(root)).open();
  const core: Record<string, unknown> = {
    [CORE_KERNELS.store]: store,
    [CORE_KERNELS.modelProviders]: PROVIDER_CATALOG,
  };
  // A capability that attaches hooks without implementing any tool, so the tests exercise
  // attribution without depending on which tool a real capability happens to own.
  const probe: CraftCapability = { name: "probe", owns: /^craft_probe_never_matches$/, register: () => {}, hooks };
  const { hooks: assembled } = buildCapabilityRegistry([...CRAFT_CAPABILITIES, probe], core);
  const plane = new HookPlane(assembled);
  // Installed on the service rather than kept beside it: `McpServer` reads `service.hookPlane`, so
  // a plane the service does not hold would test nothing about the dispatch path.
  const service = new CraftService(store);
  Object.defineProperty(service, "hookPlane", { value: plane, configurable: true, writable: true });
  return { root, store, core, plane, service };
}
async function close(f: { store: CraftStore; root: string }) {
  f.store.close();
  await rm(f.root, { recursive: true, force: true });
}

/** A service whose hook plane is absent, as one assembled before the plane existed would be. */
function withoutPlane(store: CraftStore): CraftService {
  const service = new CraftService(store);
  Object.defineProperty(service, "hookPlane", { value: undefined, configurable: true, writable: true });
  return service;
}

/** A hook that always refuses, at whichever phase it is attached to. */
const refusing = (name: string, phase: Hook["phase"]): Hook => ({
  name, phase, order: 1,
  run: async () => ({ kind: "denied", reason: `${name} says no` }),
});
const observing = (name: string, phase: Hook["phase"], seen: HookContext[]): Hook => ({
  name, phase, order: 1,
  run: async (context) => { seen.push(context); return { kind: "observed", refs: [`${name}:ok`] }; },
});

test("v0.12.43 stops a tool call at tool_before and does not dispatch it", async () => {
  const f = await fixture([refusing("probe-gate", "tool_before")]);
  try {
    // The probe capability owns no tool, and `craft_info` is owned by no capability either, so
    // this refusal is about the phase rather than about ownership.
    const server = new McpServer(f.service, "full");
    assert(server.hooks, "the server must pick up the assembled hook plane");
    const response = await server.handle({ id: 1, method: "tools/call", params: { name: "craft_info", arguments: {} } });
    const result = response!.result as { isError: boolean; structuredContent: { denied: boolean; hook: string; capability: string | null; reason: string } };
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.denied, true);
    assert.equal(result.structuredContent.hook, "probe-gate");
    // Attribution travels with the refusal, which is what lets a Host see which capability said no.
    assert.equal(result.structuredContent.capability, "probe");
    assert.equal(result.structuredContent.reason, "probe-gate says no");
    // `tool_before` refused, so `tool_after` must not have run: hooks that decide about an effect
    // that no longer happens would be deciding about nothing.
    assert.deepEqual(f.plane.records.map((record) => record.phase), ["tool_before"]);
    assert.equal(f.plane.records[0]!.denied, true);
  } finally { await close(f); }
});

test("v0.12.43 runs both tool phases and records who ran, without recording what was said", async () => {
  const seen: HookContext[] = [];
  const f = await fixture([observing("probe-before", "tool_before", seen), observing("probe-after", "tool_after", seen)]);
  try {
    const response = await new McpServer(f.service, "full").handle({ id: 2, method: "tools/call", params: { name: "craft_info", arguments: {} } });
    assert.equal((response!.result as { isError: boolean }).isError, false);
    assert.deepEqual(f.plane.records.map((record) => record.phase), ["tool_before", "tool_after"]);
    for (const record of f.plane.records) {
      assert.equal(record.hooks, 1);
      assert.equal(record.denied, false);
      assert.deepEqual(record.capabilities, ["probe"]);
    }

    // What a hook is shown, which is the part the call site has to be honest about.
    assert.equal(seen.length, 2);
    for (const context of seen) {
      assert.match(context.input_digest, /^sha256:[0-9a-f]{64}$/u);
      // No scope: a tool call at the MCP boundary may belong to no task, and inventing one would
      // put a fact into an instrumentation record that nothing observed.
      assert.equal(context.scope_kind, undefined);
      assert.equal(context.scope_id, undefined);
      // `craft_info` is owned by no capability, so no capability is claimed.
      assert.equal(context.capability, undefined);
      assert.equal(context.outcome, undefined);
    }
    assert.deepEqual(seen.map((context) => context.phase), ["tool_before", "tool_after"]);

    // The digest is over the tool and its arguments, and it is all that is kept: a different
    // argument produces a different digest, and the arguments themselves appear nowhere.
    const same = HookPlane.inputDigest("craft_info", {});
    assert.equal(seen[0]!.input_digest, same);
    assert.notEqual(HookPlane.inputDigest("craft_info", { a: 1 }), same);
    assert.equal(JSON.stringify(f.plane.records).includes("craft_info"), false, "the record names no tool");
    assert.equal(JSON.stringify(seen).includes('"a":1'), false, "the context carries no arguments");
  } finally { await close(f); }
});

test("v0.12.43 attributes a tool to its owning capability, and leaves the rest unowned", async () => {
  const seen: HookContext[] = [];
  const f = await fixture([observing("probe-before", "tool_before", seen)]);
  try {
    // One tool from each of the three packages plus two the core owns on no one's behalf.
    const cases: Array<[string, string | undefined]> = [
      ["craft_knowledge_source_list", "knowledge"],
      ["craft_memory_ledger_remember", "memory"],
      ["craft_experience_ledger_observe", "experience"],
      ["craft_context_resolution_resolve", undefined],
      ["craft_task_open", undefined],
    ];
    for (const [tool, owner] of cases) assert.equal(ownerOfTool(tool), owner, `${tool} owner`);
    for (const [tool, owner] of cases) {
      // Through the plane's own context builder, which is what the dispatch path calls.
      const context = HookPlane.toolContext(tool, {}, () => "read");
      if (owner === undefined) assert.equal(context.capability, undefined);
      else assert.deepEqual(context.capability, { name: owner, effect: "read" });
      assert.match(context.input_digest, /^sha256:/u);
    }
  } finally { await close(f); }
});

test("v0.12.43 leaves the dispatch path untouched when nothing is attached", async () => {
  const f = await fixture([]);
  try {
    const plane = new HookPlane([]);
    assert.deepEqual(plane.capabilities(), []);
    assert.deepEqual(plane.hooksAt("tool_before"), []);
    const result = await plane.run("tool_before", { input_digest: "sha256:x" });
    // An empty phase is a real result rather than a skip, so a caller never has to branch on it.
    assert.deepEqual(result, { phase: "tool_before", denied: false, outcomes: [] });
    assert.deepEqual(plane.records, [{ phase: "tool_before", hooks: 0, denied: false, capabilities: [] }]);
  } finally { await close(f); }
});

test("v0.12.43 still answers when a service has no hook plane at all", async () => {
  const f = await fixture([]);
  try {
    // A server over a service without the plane behaves exactly as it did before hooks existed,
    // which is what keeps this change an addition to the dispatch path rather than a rewrite.
    const stripped = new McpServer(withoutPlane(f.store), "full");
    assert.equal(stripped.hooks, undefined);
    const response = await stripped.handle({ id: 2, method: "tools/call", params: { name: "craft_info", arguments: {} } });
    assert.equal((response!.result as { isError: boolean }).isError, false);
  } finally { await close(f); }
});

test("v0.12.43 answers what will run at a phase before it runs", async () => {
  const seen: HookContext[] = [];
  const f = await fixture([
    { ...observing("later", "tool_before", seen), order: 9 },
    { ...observing("earlier", "tool_before", seen), order: 1 },
    { ...observing("behind", "tool_after", seen), order: 1 },
  ]);
  try {
    // `hooksAt` is the seam a Host uses to show what a capability attached, so it must agree with
    // what `run` actually executes — including the order, which is the flow's and not the
    // declaration's.
    assert.deepEqual(f.plane.hooksAt("tool_before").map((hook) => hook.name), ["earlier", "later"]);
    assert.deepEqual(f.plane.hooksAt("tool_after").map((hook) => hook.name), ["behind"]);
    assert.deepEqual(f.plane.hooksAt("turn_start"), []);
    await f.plane.run("tool_before", { input_digest: "sha256:x" });
    assert.deepEqual(seen.map((context) => context.phase), ["tool_before", "tool_before"]);
  } finally { await close(f); }
});

test("v0.12.43 refuses to let a hook claim an owner it does not have", async () => {
  const f = await fixture([]);
  try {
    // `owned` is written by the registry, never by the hook, so a capability cannot appear in
    // another capability's numbers. The declarations here deliberately omit `owned`, because a
    // hook literal cannot know its own owner — that is the registry's job.
    const impostor = (name: string, hookName: string): CraftCapability => ({
      name, owns: new RegExp(`^craft_${name}_$`), register: () => {},
      hooks: [{ name: hookName, phase: "tool_after", order: 1, run: async () => ({ kind: "observed", refs: [] }) }],
    });
    const { hooks } = buildCapabilityRegistry([...CRAFT_CAPABILITIES, impostor("alpha", "lying"), impostor("beta", "truthful")], f.core);
    assert.deepEqual(hooks.map((hook) => [hook.name, hook.owned]), [["lying", "alpha"], ["truthful", "beta"]]);
    const plane = new HookPlane(hooks);
    assert.deepEqual(plane.capabilities(), ["alpha", "beta"]);
    const result = await plane.run("tool_after", { input_digest: "sha256:x" });
    assert.deepEqual(result.outcomes.map((entry) => entry.capability), ["alpha", "beta"]);
    // And a hook run outside any registry reports no capability rather than a guessed one.
    const orphan = await new HookPlane([{ name: "orphan", phase: "tool_after", order: 1, run: async () => ({ kind: "observed", refs: [] }) }])
      .run("tool_after", { input_digest: "sha256:x" });
    assert.deepEqual(orphan.outcomes, [{ hook: "orphan", outcome: { kind: "observed", refs: [] } }]);
  } finally { await close(f); }
});
