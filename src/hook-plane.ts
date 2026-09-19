import { createHash } from "node:crypto";
import type { HookContext, HookPhase, PhaseResult } from "./capability-protocol.ts";
import { runPhase } from "./capability-protocol.ts";
import type { Hook } from "./capability-protocol.ts";
import { ownerOfTool } from "./capability-catalog.ts";

/**
 * The assembled hooks, and the one way the flow runs them.
 *
 * `capability-protocol.ts` defines *what* a hook is and how a phase behaves; this is *where a
 * phase is entered from*. Splitting them matters because the protocol must stay free of any
 * knowledge of the tool table — it is a rank-1 module and the table is in `interfaces/` — while
 * entering a phase needs to know a tool's owning capability.
 *
 * ### What a call site can honestly supply
 *
 * A hook context is mostly optional by construction, and this is the module that has to be honest
 * about which parts a given call site actually knows:
 *
 * | field | where it comes from at the MCP boundary |
 * |---|---|
 * | `input_digest` | `sha256` of the tool name and its arguments — **content-free by construction**, the same discipline `prompt_digest` and `request_digest` already follow |
 * | `scope_kind` / `scope_id` | **omitted**: a tool call may belong to no task, and inventing a scope would put a fact in an instrumentation record that nothing observed |
 * | `capability.name` | the owning capability from `ownerOfTool`, or omitted when no capability owns the tool |
 * | `capability.effect` | the tier the tool is classified into, so a gating hook can decide without a second lookup |
 *
 * ### Outcomes are recorded, because that is what makes a single capability observable
 *
 * `run` returns the phase result and, when a recorder is attached, appends one content-free
 * record per phase: which phase, which capability, how many hooks ran, whether any refused. The
 * record holds no tool arguments and no result — only the attribution and the counts — so
 * aggregating "which capability's hooks fire and how often they refuse" needs nothing that
 * would have to be redacted first.
 */
export interface HookPhaseRecord {
  readonly phase: HookPhase;
  readonly hooks: number;
  readonly denied: boolean;
  /** Capabilities whose hooks ran in this phase, deduplicated and sorted. */
  readonly capabilities: readonly string[];
}

export class HookPlane {
  readonly hooks: readonly Hook[];
  /** One record per phase run, in order. Bounded by the number of phases per turn. */
  readonly records: HookPhaseRecord[] = [];
  constructor(hooks: readonly Hook[]) { this.hooks = hooks; }

  /** The hooks attached to one phase, in execution order, so a Host can see what will run. */
  hooksAt(phase: HookPhase): readonly Hook[] {
    return this.hooks.filter((hook) => hook.phase === phase);
  }

  /** The capabilities that attached at least one hook anywhere, sorted. */
  capabilities(): string[] {
    return [...new Set(this.hooks.map((hook) => hook.owned).filter((name): name is string => name !== undefined))].sort();
  }

  /** Enter one phase. Cheap when nothing is attached: no hooks means one empty result. */
  async run(phase: HookPhase, context: Omit<HookContext, "phase">): Promise<PhaseResult> {
    const result = await runPhase(phase, context, this.hooks);
    this.records.push({
      phase,
      hooks: result.outcomes.length,
      denied: result.denied,
      capabilities: [...new Set(result.outcomes.map((entry) => entry.capability).filter((name): name is string => name !== undefined))].sort(),
    });
    return result;
  }

  /**
   * The turn's input digest, derived rather than supplied.
   *
   * A digest of the tool name and its arguments. The arguments may contain anything — that is the
   * point of hashing them — and the digest cannot be turned back into them, which is why Craft can
   * keep it while refusing to keep the conversation.
   */
  static inputDigest(toolName: string, args: unknown): string {
    return `sha256:${createHash("sha256").update(JSON.stringify({ tool: toolName, args })).digest("hex")}`;
  }

  /**
   * The context a tool call can honestly supply.
   *
   * `effect` is the classification tier rather than an effect verb because that is what the tool
   * plane already decides, and a second notion of "effect" derived here would be a second opinion.
   *
   * `capability` is **omitted** when no capability owns the tool, rather than filled with a
   * placeholder. Most tools have no owner by design, and `{name: "unowned"}` would be a
   * fabricated attribution — the record would then claim a capability ran when none did.
   */
  static toolContext(toolName: string, args: unknown, classify: (name: string) => string): Omit<HookContext, "phase"> {
    const owner = ownerOfTool(toolName);
    const effect = classify(toolName);
    return {
      input_digest: HookPlane.inputDigest(toolName, args),
      ...(owner === undefined ? {} : { capability: { name: owner, effect } }),
    };
  }
}
