import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_MEMBERS,
  CONTEXT_MEMBER_SOURCES,
  GATING_PHASES,
  HOOK_PHASES,
  buildCapabilityRegistry,
  contributesContext,
  orderHooks,
  pluggableMembers,
  runPhase,
  type CraftCapability,
  type Hook,
  type HookContext,
  type HookOutcome,
} from "../src/capability-protocol.ts";

const base = { input_digest: "sha256:x", scope_kind: "project" as const, scope_id: "p" };

/** A hook at any phase. `writes` is only legal at `task_settle`. */
const hook = (name: string, phase: Hook["phase"], order: number, run?: (c: HookContext) => Promise<HookOutcome>): Hook => ({
  name,
  phase,
  order,
  run: run ?? (async () => ({ kind: "observed", refs: [] })),
});

/** A `task_settle` hook that contributes members, and so is ordered against other contributors. */
const accumulating = (name: string, order: number, writes: readonly string[], reads?: readonly string[]): Hook => ({
  name,
  phase: "task_settle",
  order,
  writes: writes as Hook["writes"],
  ...(reads ? { reads: reads as Hook["reads"] } : {}),
  run: async () => ({ kind: "observed", refs: [] }),
});

const capability = (name: string, extra: Partial<CraftCapability> = {}): CraftCapability => ({
  name,
  owns: new RegExp(`^craft_${name}_`),
  register: () => {},
  ...extra,
});

test("v0.12.43 fixes the nature of each context member", () => {
  assert.deepEqual([...CONTEXT_MEMBERS], ["history", "knowledge", "memory", "experience", "state"]);
  // `history` is the Host's: craft is content-free and keeps only a digest.
  assert.equal(CONTEXT_MEMBER_SOURCES.history, "host_provided");
  // `state` describes the running task, so it expires with it rather than accumulating.
  assert.equal(CONTEXT_MEMBER_SOURCES.state, "current");
  // The three that survive across tasks are the three that can be a capability.
  assert.deepEqual(pluggableMembers(), ["knowledge", "memory", "experience"]);
});

test("v0.12.43 attaches hooks across the whole flow, not only after a write", () => {
  // The stages follow the run in order, and both sides of an effect are present: a rule
  // that must stop a tool call needs `tool_before`, and one that records a lesson needs
  // `task_settle`. Only two stages may refuse, and both stand in front of an effect.
  assert.deepEqual([...HOOK_PHASES], [
    "turn_start", "context_resolve", "capability_discover",
    "permission_check", "tool_before", "tool_after", "task_settle", "turn_end",
  ]);
  assert.deepEqual([...GATING_PHASES].sort(), ["permission_check", "tool_before"]);
});

test("v0.12.43 orders hooks by the flow before the number", () => {
  // A hook cannot place itself before `turn_start` by choosing a small enough `order`:
  // phase order is the run's order and dominates.
  const ordered = orderHooks([
    hook("late-stage", "turn_end", 1),
    hook("early-stage", "turn_start", 999),
    hook("mid-b", "tool_before", 5),
    hook("mid-a", "tool_before", 5),
  ]);
  assert.deepEqual(ordered.map((entry) => entry.name), ["early-stage", "mid-a", "mid-b", "late-stage"]);
});

test("v0.12.43 separates a hook that contributes context from one that only records", () => {
  // A `task_settle` hook may contribute a member, or merely write a ledger entry no future
  // context resolves. Only the first can be depended on, so only the first is ordered.
  assert.equal(contributesContext(accumulating("a", 1, ["memory"])), true);
  assert.equal(contributesContext(hook("records-only", "task_settle", 1)), false);
  assert.equal(contributesContext({ ...hook("empty", "task_settle", 1), writes: [] }), false);
  assert.equal(contributesContext(hook("b", "tool_after", 1)), false);
  // A recording hook is legal and simply does not participate in the ordering check.
  const { hooks } = buildCapabilityRegistry([capability("a", { hooks: [hook("records-only", "task_settle", 1)] })]);
  assert.equal(hooks.length, 1);
});

test("v0.12.43 assembles capabilities without the core naming an implementation", () => {
  const assembled: string[] = [];
  const { registry } = buildCapabilityRegistry([
    { name: "first", owns: /^craft_first_/, register: (r) => { r.provide("firstKernel", { ok: true }); assembled.push("first"); } },
    { name: "second", owns: /^craft_second_/, register: (r) => {
      const first = r.require<{ ok: boolean }>("firstKernel");
      assembled.push(`second:${String(first.ok)}`);
    } },
  ]);
  assert.deepEqual(assembled, ["first", "second:true"]);
  assert.deepEqual(registry.require("firstKernel"), { ok: true });
  assert.equal(registry.optional("nothingHere"), undefined);
});

test("v0.12.43 refuses two capabilities claiming one name or one kernel", () => {
  assert.throws(() => buildCapabilityRegistry([capability("same"), capability("same")]), /capability already registered: same/u);
  assert.throws(
    () => buildCapabilityRegistry([
      { name: "a", owns: /^a/, register: (r) => r.provide("shared", 1) },
      { name: "b", owns: /^b/, register: (r) => r.provide("shared", 2) },
    ]),
    /kernel already registered: shared/u,
  );
  assert.throws(() => buildCapabilityRegistry([{ name: "a", owns: /^a/, register: (r) => r.provide("  ", 1) }]), /kernel name must not be empty/u);
});

test("v0.12.43 requires a kernel to exist before it is resolved", () => {
  const { registry } = buildCapabilityRegistry([capability("a")]);
  assert.throws(() => registry.require("missing"), /kernel is not registered: missing/u);
  assert.equal(registry.optional("missing"), undefined);
});

test("v0.12.43 rejects any dependency on a capability declared later", () => {
  assert.throws(() => buildCapabilityRegistry([
    { name: "consumer", owns: /^c/, register: (r) => r.require("late") },
    { name: "producer", owns: /^p/, register: (r) => r.provide("late", 1) },
  ]), /kernel is not registered: late/u);
});

test("v0.12.43 only lets accumulated members be contributed", () => {
  const provider = (member: string) => ({
    member: member as never,
    contribute: async () => ({ member: member as never, items: [], receipt_id: "r", omitted_count: 0 }),
  });
  assert.equal(buildCapabilityRegistry([capability("k", { contributes: () => provider("knowledge") })]).contributed.length, 1);
  assert.throws(() => buildCapabilityRegistry([capability("h", { contributes: () => provider("history") })]), /only accumulated members can be contributed; history is host_provided/u);
  assert.throws(() => buildCapabilityRegistry([capability("s", { contributes: () => provider("state") })]), /only accumulated members can be contributed; state is current/u);
});

test("v0.12.43 refuses two capabilities contributing one context member", () => {
  const provider = (member: string) => ({
    member: member as never,
    contribute: async () => ({ member: member as never, items: [], receipt_id: "r", omitted_count: 0 }),
  });
  assert.throws(
    () => buildCapabilityRegistry([capability("a", { contributes: () => provider("memory") }), capability("b", { contributes: () => provider("memory") })]),
    /two capabilities contribute the same context member: memory/u,
  );
});

test("v0.12.43 refuses a hook that writes outside the accumulating stage", () => {
  // `writes` describes a context member, and only `task_settle` produces one. Declaring it
  // on a gating hook would be a category error, not a harmless extra field.
  const bogus = { ...hook("gate", "tool_before", 1), writes: ["memory"] } as unknown as Hook;
  assert.throws(() => buildCapabilityRegistry([capability("a", { hooks: [bogus] })]), /hook gate declares writes at phase tool_before/u);
  const unknown = { ...hook("x", "nonsense" as never, 1) };
  assert.throws(() => buildCapabilityRegistry([capability("a", { hooks: [unknown] })]), /hook x declares an unknown phase: nonsense/u);
  // The same prohibition covers `reads`: only the accumulating stage orders itself
  // against other hooks, so a gating hook declaring a dependency is also a category error.
  const readingGate = { ...hook("gate-reads", "permission_check", 1), reads: ["memory"] } as unknown as Hook;
  assert.throws(() => buildCapabilityRegistry([capability("a", { hooks: [readingGate] })]), /hook gate-reads declares reads at phase permission_check/u);
  assert.throws(() => buildCapabilityRegistry([
    capability("a", { hooks: [accumulating("h", 1, ["nonsense"])] }),
  ]), /hook h writes an unknown member: nonsense/u);
  assert.throws(() => buildCapabilityRegistry([
    capability("a", { hooks: [accumulating("h", 1, ["memory"], ["nonsense"])] }),
  ]), /hook h reads an unknown member: nonsense/u);
  assert.throws(() => buildCapabilityRegistry([
    capability("a", { hooks: [accumulating("h", 1, ["state"])] }),
  ]), /hook h writes state, which is current/u);
  assert.throws(() => buildCapabilityRegistry([
    capability("a", { hooks: [accumulating("h", 1, ["memory"])] }),
    capability("b", { hooks: [accumulating("h", 2, ["knowledge"])] }),
  ]), /hook already registered: h/u);
});

test("v0.12.43 fails an evolution hook that runs before its inputs exist", () => {
  // The check an earlier draft only appeared to make: a loop that walked the hooks,
  // tested a condition, and discarded the result.
  assert.throws(
    () => buildCapabilityRegistry([
      capability("experience", { hooks: [accumulating("distil", 1, ["experience"], ["memory", "knowledge"])] }),
      capability("memory", { hooks: [accumulating("record-memory", 5, ["memory"])] }),
      capability("knowledge", { hooks: [accumulating("record-knowledge", 6, ["knowledge"])] }),
    ]),
    /hook distil reads memory, but no earlier hook writes it/u,
  );
  const { hooks } = buildCapabilityRegistry([
    capability("memory", { hooks: [accumulating("record-memory", 1, ["memory"])] }),
    capability("knowledge", { hooks: [accumulating("record-knowledge", 2, ["knowledge"])] }),
    capability("experience", { hooks: [accumulating("distil", 3, ["experience"], ["memory", "knowledge"])] }),
  ]);
  assert.deepEqual(hooks.map((entry) => entry.name), ["record-memory", "record-knowledge", "distil"]);
});

test("v0.12.43 breaks an accumulation tie by name so the order is total", () => {
  // Two contributors at the same `order` would otherwise be ordered by registration, which
  // varies with capability declaration. Sorting by name makes the sequence reproducible.
  const { hooks } = buildCapabilityRegistry([
    capability("b", { hooks: [accumulating("zeta", 4, ["experience"])] }),
    capability("a", { hooks: [accumulating("alpha", 4, ["memory"])] }),
  ]);
  assert.deepEqual(hooks.map((entry) => entry.name), ["alpha", "zeta"]);
});

test("v0.12.43 does not require a producer for a member that needs none", () => {
  const { hooks } = buildCapabilityRegistry([
    capability("experience", { hooks: [accumulating("distil", 1, ["experience"], ["history", "state"])] }),
  ]);
  assert.equal(hooks.length, 1);
});

test("v0.12.43 runs one phase in order and reports every outcome", async () => {
  const seen: string[] = [];
  const { hooks } = buildCapabilityRegistry([
    capability("a", { hooks: [
      hook("second", "tool_before", 2, async () => { seen.push("second"); return { kind: "observed", refs: ["r2"] }; }),
      hook("first", "tool_before", 1, async () => { seen.push("first"); return { kind: "observed", refs: ["r1"] }; }),
      hook("elsewhere", "tool_after", 1, async () => { seen.push("elsewhere"); return { kind: "observed", refs: [] }; }),
    ] }),
  ]);
  const result = await runPhase("tool_before", base, hooks);
  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(result.denied, false);
  assert.equal(result.phase, "tool_before");
  assert.deepEqual(result.outcomes.map((entry) => entry.hook), ["first", "second"]);
});

test("v0.12.43 lets only a gating phase refuse, and stops the phase there", async () => {
  const seen: string[] = [];
  const { hooks } = buildCapabilityRegistry([
    capability("a", { hooks: [
      hook("deny", "permission_check", 1, async () => { seen.push("deny"); return { kind: "denied", reason: "external write" }; }),
      hook("after", "permission_check", 2, async () => { seen.push("after"); return { kind: "observed", refs: [] }; }),
    ] }),
  ]);
  const result = await runPhase("permission_check", base, hooks);
  assert.equal(result.denied, true);
  // The later hook does not run: it would decide about an effect that is not happening.
  assert.deepEqual(seen, ["deny"]);

  // The same refusal at a stage with nothing to refuse is a contract violation.
  const observing = buildCapabilityRegistry([
    capability("b", { hooks: [hook("bad", "tool_after", 1, async () => ({ kind: "denied", reason: "too late" }))] }),
  ]).hooks;
  await assert.rejects(runPhase("tool_after", base, observing), /hook bad refused at phase tool_after, which cannot refuse/u);
});

test("v0.12.43 reports a throwing hook as unobserved rather than failing the work", async () => {
  // Accumulation is a side channel. A hook that breaks must not change the outcome of the
  // work it watched, so the failure is reported as an observation that did not happen.
  const { hooks } = buildCapabilityRegistry([
    capability("a", { hooks: [
      hook("broken", "task_settle", 1, async () => { throw new Error("boom"); }),
      hook("fine", "task_settle", 2),
    ] }),
  ]);
  const result = await runPhase("task_settle", { ...base, outcome: { task_id: "t", outcome: "succeeded", result_digests: [], scope_kind: "project", scope_id: "p" } }, hooks);
  assert.deepEqual(result.outcomes.map((entry) => entry.outcome.kind), ["unobserved", "observed"]);
  assert.equal(result.outcomes[0]!.outcome.kind === "unobserved" && result.outcomes[0]!.outcome.reason, "boom");
  // A non-Error throw is still reported, not swallowed.
  const thrown = buildCapabilityRegistry([
    capability("b", { hooks: [hook("weird", "task_settle", 1, async () => { throw "plain"; })] }),
  ]).hooks;
  const odd = await runPhase("task_settle", base, thrown);
  assert.equal(odd.outcomes[0]!.outcome.kind === "unobserved" && odd.outcomes[0]!.outcome.reason, "plain");
});

test("v0.12.43 runs no hook for a phase nothing attached to", async () => {
  const { hooks } = buildCapabilityRegistry([capability("a", { hooks: [hook("only", "turn_start", 1)] })]);
  const result = await runPhase("turn_end", base, hooks);
  assert.deepEqual(result.outcomes, []);
  assert.equal(result.denied, false);
});
