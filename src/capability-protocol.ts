/**
 * The internal extension protocol.
 *
 * Craft reaches the outside world over MCP, and that is the right protocol for a Host:
 * a stable product name, a bounded tool surface, a syscall vocabulary. But MCP is not
 * what components inside the process should use to find each other. Doing so would mean
 * naming a capability with a string, discovering it through a regular expression, and
 * learning its shape only at call time — which is what `SURFACE_RULES` and
 * `service-foundation.ts` do today, and both have been measured to mislead:
 *
 *  - `service-foundation.ts` constructs 30+ kernels inline, nine of them belonging to
 *    knowledge and memory, so a capability cannot be added or omitted.
 *  - `SURFACE_RULES` decides a tool's home by matching its **name**, and reordering the
 *    rules moves four tools between domains without renaming anything.
 *
 * This file is the other layer: an in-process contract, checked by the compiler, by
 * which a capability states what it assembles, what it owns, what it contributes to the
 * context, and what it does when a task settles.
 *
 * ### Where a capability sits in the harness
 *
 * ```
 * agent   = model + harness
 * harness = permission + tool + environment + context   (+ hook, orthogonal)
 * context = history + knowledge + memory + experience + state
 * ```
 *
 * A capability is the unit that contributes to **one of those context members**, and it
 * does so in exactly two directions:
 *
 *  - **read** — {@link ContextContribution} puts its material into a turn's context.
 *  - **write** — {@link AccumulationHook} records what a finished task taught it.
 *
 * The three accumulating members are symmetric that way. They differ from the other two,
 * and the difference is what this contract has to encode:
 *
 * | member | held by | lifetime | gate |
 * |---|---|---|---|
 * | `history` | the Host | the conversation | craft stores only a digest |
 * | `knowledge` | craft | across tasks | Evidence |
 * | `memory` | craft | across tasks | explicit approval |
 * | `experience` | craft | across tasks | evaluation + signoff before it becomes a Workflow |
 * | `state` | craft | the current task | none; it expires with the task |
 *
 * `history` is deliberately not a capability: Craft is content-free by design, so it
 * receives a query and persists only `query_digest`. `state` is not one either — it
 * describes the current execution rather than accumulating, so it is read from live
 * records (`state_snapshot`, `task_run_state`, `context_manifest`) instead of retrieved
 * by scope. That leaves **history and state built in, and knowledge, memory and
 * experience pluggable** — which is also why only those three are candidates for their
 * own package.
 */
import type { JsonObject } from "./infrastructure/store.ts";

/** A context member a capability can contribute to, and how it behaves. */
export const CONTEXT_MEMBERS = ["history", "knowledge", "memory", "experience", "state"] as const;
export type ContextMember = typeof CONTEXT_MEMBERS[number];

/**
 * How a member is obtained, which is what decides whether it can be a capability at all.
 *
 * - `host_provided` — the Host supplies it; craft keeps only a digest. Cannot be packaged.
 * - `accumulated` — craft stores it across tasks, under a scope, behind a gate.
 * - `current` — it describes the running task and expires with it.
 */
export const CONTEXT_SOURCES = ["host_provided", "accumulated", "current"] as const;
export type ContextSource = typeof CONTEXT_SOURCES[number];

/** The fixed nature of each member. Declared here so a capability cannot redefine it. */
export const CONTEXT_MEMBER_SOURCES: Readonly<Record<ContextMember, ContextSource>> = {
  history: "host_provided",
  knowledge: "accumulated",
  memory: "accumulated",
  experience: "accumulated",
  // Not accumulated, so not a capability: read from the running task's own records.
  state: "current",
};

/** The members that are therefore pluggable. */
export function pluggableMembers(): ContextMember[] {
  return CONTEXT_MEMBERS.filter((member) => CONTEXT_MEMBER_SOURCES[member] === "accumulated");
}

/** Where a capability's contribution is read from, mirroring craft's existing scopes. */
export interface ContextRequest {
  readonly query: string;
  readonly scope_kind: "user" | "project" | "task" | "workspace" | "session";
  readonly scope_id: string;
  readonly max_items: number;
  readonly max_chars: number;
}

/** A bounded contribution, with the provenance a reader needs to trust it. */
export interface ContextContribution {
  /** The member this came from; it must be the one the capability declared. */
  readonly member: ContextMember;
  /** Bounded excerpts. Never raw restricted content. */
  readonly items: readonly JsonObject[];
  /** Content-free receipt id, so a pack can be reproduced without storing the query. */
  readonly receipt_id: string;
  /** How many candidates were dropped by the budget, stated rather than hidden. */
  readonly omitted_count: number;
}

/**
 * A contribution to a turn's context, from one accumulating member.
 *
 * Only an accumulating member can be contributed — `history` belongs to the Host and `state`
 * to the running task — and `buildCapabilityRegistry` rejects anything else rather than leaving
 * this as a convention.
 *
 * The self-hosted case is worth stating explicitly, because it looks like a counterexample and
 * is not one. When Craft runs its own loop (`internal-host-driver.ts`), Craft *is* the Host: it
 * holds the transcript in `internal_session` and compacts it directly against the model request
 * it is about to build. It never asks itself for a `ContextContribution`, because a contribution
 * is what a Host that keeps its own prompt asks *Craft* for — and a Host that is Craft needs no
 * such round trip. So `history` stays `host_provided` in both modes; what changes is who the
 * host is, not which member is pluggable.
 *
 * If a future transcript capability were to serve an *external* Host the way knowledge does,
 * that would be a deliberate change to `CONTEXT_MEMBER_SOURCES.history`, with the reason
 * recorded there. It is not a change to this interface.
 */
export interface ContextContributionProvider {
  readonly member: ContextMember;
  contribute(request: ContextRequest): Promise<ContextContribution>;
}

/** What a finished task reports, so every hook sees the same facts. */
export interface TaskOutcome {
  readonly task_id: string;
  readonly outcome: "succeeded" | "failed" | "waiting" | "blocked";
  /** Digests of the observable result, not the result. */
  readonly result_digests: readonly string[];
  readonly scope_kind: "user" | "project" | "task" | "workspace" | "session";
  readonly scope_id: string;
}

/**
 * Points in the run at which a hook may attach.
 *
 * A hook is not a post-write callback. It is an extension point on the flow, and the flow
 * has stages that matter on both sides of the work: a rule may need to see a tool call
 * *before* it happens to stop it, and a memory may need to be written *after* a task
 * settles to be worth anything. An earlier draft of this file defined only
 * `AccumulationHook` and attached it to task completion; that contradicted its own
 * framing, where a hook is the orthogonal axis — the *when* — alongside permission, tool
 * and context, which answer *what*.
 *
 * The stages follow the flow Craft already runs, in order.
 */
export const HOOK_PHASES = [
  /** A turn begins; the policy is decided and the input digest is known. */
  "turn_start",
  /** The context pack is being assembled from its members. */
  "context_resolve",
  /** Capability discovery is running against a query. */
  "capability_discover",
  /** An effect is being authorised. */
  "permission_check",
  /** A tool is about to run. */
  "tool_before",
  /** A tool has returned. */
  "tool_after",
  /** A task settled with one of the four outcomes; accumulation belongs here. */
  "task_settle",
  /** The turn is closing. */
  "turn_end",
] as const;
export type HookPhase = typeof HOOK_PHASES[number];

/**
 * Stages where a hook may refuse rather than merely observe.
 *
 * Only the two that stand in front of an effect. Everywhere else a refusal would have
 * nothing to refuse — the tool has already run, or the turn is already over — so a
 * `denied` result there is a contract violation rather than a decision, and is rejected
 * at assembly rather than silently ignored at runtime.
 */
export const GATING_PHASES: ReadonlySet<HookPhase> = new Set<HookPhase>(["permission_check", "tool_before"]);

/** Stable names used by the unified Harness lifecycle. They map onto the existing HookPlane
 * phases so older components keep their protocol while new components can speak the domain flow. */
export const HARNESS_HOOK_POINTS = [
  "before_context", "before_activation", "before_preflight", "before_execute",
  "after_receipt", "after_observe", "before_accept", "after_outcome", "before_candidate_publish",
] as const;
export type HarnessHookPoint = typeof HARNESS_HOOK_POINTS[number];
export const HARNESS_HOOK_PHASE_MAP: Readonly<Record<HarnessHookPoint, HookPhase>> = {
  before_context: "context_resolve", before_activation: "capability_discover", before_preflight: "permission_check",
  before_execute: "tool_before", after_receipt: "tool_after", after_observe: "tool_after",
  before_accept: "permission_check", after_outcome: "task_settle", before_candidate_publish: "task_settle",
};

/** What a hook is shown. Members are optional because a stage only sees what exists yet. */
export interface HookContext {
  readonly phase: HookPhase;
  /** The turn's input digest. Never the content: Craft does not hold the conversation. */
  readonly input_digest: string;
  /**
   * The scope this stage can see, when it has one.
   *
   * **Optional on purpose.** Not every stage knows a scope: a `tool_before` hook at the MCP
   * boundary sees a tool call that may belong to no task at all. Requiring a scope there would
   * force every call site to invent one, and an invented scope in an instrumentation record is
   * worse than an absent one — it reads as a fact. A stage that genuinely has a task, a run or a
   * loop supplies its real scope; one that does not, omits it.
   */
  readonly scope_kind?: "user" | "project" | "task" | "workspace" | "session";
  readonly scope_id?: string;
  /**
   * The capability being exercised, when the stage is about one.
   *
   * Set from `capability_discover` onward. `name` is the **owning capability** rather than the
   * tool: a tool belongs to a capability, and instrumentation wants the capability's numbers
   * aggregated. `effect` is what the tool would do, so a permission hook can decide without
   * looking anything up.
   */
  readonly capability?: { readonly name: string; readonly effect: string };
  /** Present from `task_settle` onward. */
  readonly outcome?: TaskOutcome;
}

/**
 * What a hook produced.
 *
 * `unobserved` is a first-class result, not an error: a hook that could not decide has
 * not failed, and neither has the work it watched. Recording it as a failure would let a
 * side channel alter the outcome of the thing it observes — the mistake each of the
 * coverage gate, the evaluation suite and the run.ts credential check had to be taught
 * not to make.
 *
 * `denied` is available only in a {@link GATING_PHASES} stage.
 */
export type HookOutcome =
  | { readonly kind: "observed"; readonly refs: readonly string[] }
  | { readonly kind: "proposed"; readonly refs: readonly string[] }
  | { readonly kind: "unobserved"; readonly reason: string }
  | { readonly kind: "denied"; readonly reason: string };

/**
 * Work a capability does at one point in the flow.
 *
 * `order` breaks ties within a phase, ascending. It does **not** order across phases —
 * the flow does that by construction.
 *
 * A hook does not name its own capability. `buildCapabilityRegistry` fills {@link owned} in while
 * assembling, so a capability cannot claim a hook it did not declare, and an instrument that
 * aggregates by capability does not have to trust a string the hook wrote about itself.
 */
export interface Hook {
  readonly name: string;
  readonly phase: HookPhase;
  readonly order: number;
  /**
   * The capability that declared this hook.
   *
   * Absent on the object a capability writes and present on the one the registry returns, which is
   * why it is optional rather than required: a `Hook` literal cannot know its own owner, and
   * asking it to would make every declaration repeat a name the registry already has.
   */
  readonly owned?: string;
  /**
   * Context members this hook adds for a later turn to read. Legal only at `task_settle`.
   *
   * Optional because an accumulating hook may only *record* — a ledger entry that no
   * future context resolves — and that is a different thing from contributing a member.
   * A hook with `writes` participates in the accumulation ordering check; one without
   * does not, because nothing downstream can depend on it.
   */
  readonly writes?: readonly ContextMember[];
  /**
   * Members this hook requires an earlier accumulating hook to have written.
   *
   * What makes "accumulation precedes evolution" checkable rather than a comment. A hook
   * that distils experience must say it reads `memory` and `knowledge`; the registry then
   * verifies an earlier hook writes each. Without it the claim would be an ordering
   * convention nothing could falsify — and an earlier draft of this file had exactly that
   * flaw: a loop that walked the hooks, tested a condition and discarded the result.
   *
   * Members that are `host_provided` or `current` need no producer and are not listed.
   */
  readonly reads?: readonly ContextMember[];
  run(context: HookContext): Promise<HookOutcome>;
}

/**
 * Whether this hook contributes a context member, and so must be ordered against others.
 *
 * A type guard as well as a predicate: it is what lets the ordering check iterate
 * `hook.writes` without a `?? []` fallback. That fallback would be unreachable — the
 * filter already established the array is non-empty — and an unreachable defensive branch
 * is a claim of doubt about a condition the caller just proved.
 */
export function contributesContext(hook: Hook): hook is Hook & { writes: readonly ContextMember[] } {
  return hook.phase === "task_settle" && (hook.writes?.length ?? 0) > 0;
}

/**
 * One pluggable capability.
 *
 * The four members answer four different questions, and each replaces something that
 * currently exists as an implicit convention:
 *
 * | member | replaces | measured problem |
 * |---|---|---|
 * | `register` | `service-foundation.ts` constructing 30+ kernels inline | nine belong to knowledge and memory, so neither can be omitted |
 * | `owns` | `SURFACE_RULES` matching tool **names** | reordering rules moves four tools between domains |
 * | `contributes` | the context surface regex implying who is in context | the decision reads `intents.has("knowledge")` only, so memory is in the surface but not in the decision |
 * | `hooks` | turn proposals submitted by the Host | content-free and not orchestrated, so nothing accumulates automatically |
 */
export interface CraftCapability {
  /** Stable identity, used in reports and in the registry. */
  readonly name: string;
  /** The MCP product name, when this capability is exposed as a bounded product. */
  readonly product?: string;
  /**
   * The capability's single-point Evaluation Contract descriptor.
   *
   * Product capabilities must provide it at assembly time.  It stays optional
   * in this low-level type so test-only hooks and in-process probes can model a
   * seam without accidentally becoming installable products.
   */
  readonly evaluation?: {
    readonly input_contract: string;
    readonly output_contract: string;
    readonly fixture_id: string;
    readonly host_compatibility: readonly string[];
  };
  /**
   * Tool names this capability owns.
   *
   * Declared by the capability rather than inferred from a shared rule list, so two
   * capabilities cannot silently both claim a tool and neither depends on rule order.
   */
  readonly owns: RegExp;
  /** Assemble this capability's kernels into the shared registry. */
  register(registry: CapabilityRegistry): void;
  /**
   * Build this capability's context contribution, if it has one.
   *
   * A **factory** rather than a plain provider, because a provider needs the kernels `register`
   * just built — and which kernel that is only the registry knows. A static object cannot hold a
   * store that does not exist until assembly, so a capability with a genuine read side had no way
   * to declare one. No capability had a contribution when this changed, which is why making it a
   * factory cost nothing.
   *
   * Called after every `register`, in capability order, so a provider may `require` anything the
   * environment or an earlier capability provided.
   */
  readonly contributes?: (registry: CapabilityRegistry) => ContextContributionProvider;
  /**
   * Work this capability does at points in the flow.
   *
   * `Hook` at any phase — this is not only accumulation. A capability may observe the
   * turn, contribute to context resolution, gate a tool call, or record what a settled
   * task taught it, and it declares which by the hook's `phase`.
   */
  readonly hooks?: readonly Hook[];
}

/**
 * What a capability is handed at registration.
 *
 * A capability registers rather than imports, so the core never names an implementation.
 * That is the property `service-foundation.ts` lacks today.
 */
export interface CapabilityRegistry {
  /** Make a kernel available under a name other capabilities may resolve. */
  provide(kernel: string, instance: unknown): void;
  /** Resolve a kernel another capability registered. Throws when absent, never returns undefined. */
  require<T>(kernel: string): T;
  /** Resolve a kernel if present, for optional collaboration. */
  optional<T>(kernel: string): T | undefined;
}

/**
 * What the core contributes to the registry, before any capability registers.
 *
 * Declared here rather than in each capability so two capabilities cannot disagree about the
 * name of the store, and so `service-foundation.ts` has exactly one list to seed. A
 * capability `require`s these; it can never `provide` them, because both are decided before
 * the capability set is known.
 */
export const CORE_KERNELS = {
  store: "core.store",
  modelProviders: "core.model_providers",
} as const;

/**
 * Assemble a capability set into a registry, rejecting two capabilities claiming one name.
 *
 * `core` is what the host process itself contributes, and it is registered before any
 * capability runs. It exists because a capability must not own the environment it runs in:
 * the store and the settings-derived model catalogue are decided before the capability set
 * is known, so a capability *requires* them and cannot provide them. Without this seam the
 * only ways to give `evaluation-model-profile` its provider list would be for the capability
 * to reach back into the core (making the dependency circular) or for the core to keep
 * constructing that kernel inline — which is the coupling this contract removes.
 */
export function buildCapabilityRegistry(
  capabilities: readonly CraftCapability[],
  core: Readonly<Record<string, unknown>> = {},
): {
  registry: CapabilityRegistry;
  contributed: ContextContributionProvider[];
  hooks: Hook[];
} {
  const kernels = new Map<string, unknown>();
  const names = new Set<string>();

  const registry: CapabilityRegistry = {
    provide: (kernel, instance) => {
      if (!kernel.trim()) throw new Error("kernel name must not be empty");
      if (kernels.has(kernel)) throw new Error(`kernel already registered: ${kernel}`);
      kernels.set(kernel, instance);
    },
    require: <T,>(kernel: string): T => {
      if (!kernels.has(kernel)) throw new Error(`kernel is not registered: ${kernel}`);
      return kernels.get(kernel) as T;
    },
    optional: <T,>(kernel: string): T | undefined => kernels.get(kernel) as T | undefined,
  };

  for (const [kernel, instance] of Object.entries(core)) registry.provide(kernel, instance);

  for (const capability of capabilities) {
    if (names.has(capability.name)) throw new Error(`capability already registered: ${capability.name}`);
    if (capability.product && !capability.evaluation) {
      throw new Error(`product capability ${capability.name} requires an Evaluation Contract descriptor`);
    }
    names.add(capability.name);
  }
  // Registration order is the capability order, so a capability may depend on one
  // declared before it. A later one is not visible, which keeps the graph acyclic.
  for (const capability of capabilities) capability.register(registry);

  // Factories run after every `register`, so a contribution may `require` what assembly built.
  const contributed = capabilities
    .map((capability) => capability.contributes?.(registry))
    .filter((provider): provider is ContextContributionProvider => provider !== undefined);
  for (const provider of contributed) {
    if (CONTEXT_MEMBER_SOURCES[provider.member] !== "accumulated") {
      throw new Error(`only accumulated members can be contributed; ${provider.member} is ${CONTEXT_MEMBER_SOURCES[provider.member]}`);
    }
  }

  // Two capabilities contributing one member would make "how many members is context"
  // depend on load order, which is the class of problem this contract exists to remove.
  const members = contributed.map((provider) => provider.member);
  const duplicate = members.find((member, index) => members.indexOf(member) !== index);
  if (duplicate) throw new Error(`two capabilities contribute the same context member: ${duplicate}`);

  // Hooks are collected with their owner stamped on, so instrumentation can aggregate by
  // capability without trusting a string a hook wrote about itself. A capability that declares a
  // hook cannot claim a different owner: the registry is the only writer of `owned`.
  const hooks: Hook[] = capabilities.flatMap((capability) =>
    (capability.hooks ?? []).map((hook) => ({ ...hook, owned: capability.name })));
  const hookNames = new Set<string>();
  for (const hook of hooks) {
    if (hookNames.has(hook.name)) throw new Error(`hook already registered: ${hook.name}`);
    hookNames.add(hook.name);
    if (!HOOK_PHASES.includes(hook.phase)) throw new Error(`hook ${hook.name} declares an unknown phase: ${String(hook.phase)}`);
    // `writes` and `reads` describe a context member, and only `task_settle` produces or
    // consumes one. Declaring either at another stage is a category error rather than a
    // harmless extra field: a hook that gates a tool call does not change what the next
    // turn reads.
    if (hook.phase !== "task_settle") {
      if (hook.writes !== undefined) throw new Error(`hook ${hook.name} declares writes at phase ${hook.phase}; only task_settle accumulates a context member`);
      if (hook.reads !== undefined) throw new Error(`hook ${hook.name} declares reads at phase ${hook.phase}; only task_settle orders itself against accumulation`);
    }
  }

  // Accumulation precedes evolution, and this is where that claim is checked instead of
  // asserted. Only hooks that contribute a member participate: they are the only ones a
  // later hook can depend on, so they are the only ones whose relative order can be wrong.
  const contributing = hooks.filter(contributesContext)
    .sort((left, right) => left.order - right.order || left.name.localeCompare(right.name));
  const produced = new Set<ContextMember>();
  for (const hook of contributing) {
    for (const member of hook.reads ?? []) {
      if (!CONTEXT_MEMBERS.includes(member)) throw new Error(`hook ${hook.name} reads an unknown member: ${member}`);
      // A member the Host supplies or the task itself carries is available without a hook.
      if (CONTEXT_MEMBER_SOURCES[member] !== "accumulated") continue;
      if (!produced.has(member)) {
        throw new Error(
          `hook ${hook.name} reads ${member}, but no earlier hook writes it; `
          + `either lower ${hook.name}'s order below the hook that records ${member}, or drop the dependency`,
        );
      }
    }
    for (const member of hook.writes) {
      // Membership first: an unknown name would otherwise be reported through the
      // source lookup as "which is undefined", which names the symptom, not the mistake.
      if (!CONTEXT_MEMBERS.includes(member)) throw new Error(`hook ${hook.name} writes an unknown member: ${member}`);
      if (CONTEXT_MEMBER_SOURCES[member] !== "accumulated") {
        throw new Error(`hook ${hook.name} writes ${member}, which is ${CONTEXT_MEMBER_SOURCES[member]} and not a capability's to write`);
      }
      produced.add(member);
    }
  }

  return { registry, contributed, hooks: orderHooks(hooks) };
}

/**
 * Every hook, ordered by the flow rather than by number.
 *
 * Phase order is the run's order, so a hook cannot place itself before `turn_start` by
 * choosing a small enough `order`. Within a phase, `order` breaks ties and the name breaks
 * a tie between equal orders, so the sequence is total and reproducible.
 */
export function orderHooks(hooks: readonly Hook[]): Hook[] {
  return [...hooks].sort((left, right) => {
    const byPhase = HOOK_PHASES.indexOf(left.phase) - HOOK_PHASES.indexOf(right.phase);
    return byPhase || left.order - right.order || left.name.localeCompare(right.name);
  });
}

/**
 * One hook's result, attributed.
 *
 * `capability` is the owner the registry stamped on, and it is what makes per-capability
 * instrumentation possible: a reader can aggregate a phase by capability without knowing which
 * hook names belong to whom, and a capability's own numbers can be read out of a shared flow.
 * Without it, `outcomes` says which hooks ran and not which capability did anything.
 */
export interface HookOutcomeEntry {
  readonly hook: string;
  /** The capability that declared the hook; `undefined` for a hook run outside a registry. */
  readonly capability?: string;
  readonly outcome: HookOutcome;
}

/** What one phase produced, so a caller can tell observation from refusal. */
export interface PhaseResult {
  readonly phase: HookPhase;
  /** True when a gating hook refused, in which case later hooks in the phase did not run. */
  readonly denied: boolean;
  readonly outcomes: readonly HookOutcomeEntry[];
}

/**
 * Run every hook attached to one phase, in order.
 *
 * Three rules make a hook safe to attach anywhere in the flow:
 *
 * 1. **Only a gating phase may refuse.** `denied` from `tool_after` would have nothing to
 *    refuse, so it is rejected instead of being quietly treated as an observation.
 * 2. **A refusal stops the phase.** Later hooks in a gating phase do not run, because they
 *    would be deciding about an effect that is no longer going to happen.
 * 3. **A thrown hook is `unobserved`, not a failure.** Accumulation is a side channel; a
 *    hook that breaks must not change the outcome of the work it watched. Callers receive
 *    it as an outcome, so it is visible without being load-bearing.
 */
export async function runPhase(
  phase: HookPhase,
  context: Omit<HookContext, "phase">,
  hooks: readonly Hook[],
): Promise<PhaseResult> {
  const outcomes: HookOutcomeEntry[] = [];
  const gating = GATING_PHASES.has(phase);
  for (const hook of orderHooks(hooks).filter((entry) => entry.phase === phase)) {
    let outcome: HookOutcome;
    try {
      outcome = await hook.run({ ...context, phase });
    } catch (error) {
      outcome = { kind: "unobserved", reason: error instanceof Error ? error.message : String(error) };
    }
    if (outcome.kind === "denied" && !gating) {
      throw new Error(`hook ${hook.name} refused at phase ${phase}, which cannot refuse; only ${[...GATING_PHASES].join(" and ")} may deny`);
    }
    // `owned` is `undefined` only for a hook that was never assembled into a registry, which is
    // how a unit test can run one in isolation without inventing an owner for it.
    outcomes.push({ hook: hook.name, ...(hook.owned === undefined ? {} : { capability: hook.owned }), outcome });
    if (outcome.kind === "denied") return { phase, denied: true, outcomes };
  }
  return { phase, denied: false, outcomes };
}
