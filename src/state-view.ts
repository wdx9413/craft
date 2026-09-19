import type { CraftStore, JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";

/**
 * One read-only view of `state`.
 *
 * `state` was described in `context-members.md` as a triple — a content-free Workspace snapshot, a
 * `task_run_state` decision projection, and a digest-pinned `context_manifest` — and answering
 * "where is this task" meant reading three collections and knowing how they relate. That is the
 * reason the member was hard to reason about: the answer existed, but only as an assembly the reader
 * had to perform.
 *
 * This kernel performs that assembly once, and it is **read-only** by construction: it has no
 * method that writes, and the one thing it adds is a `status` that is derived rather than stored.
 * Nothing here can become a second source of truth, which is the risk a "unified view" otherwise
 * carries.
 *
 * ### The precedence, and why it is a precedence
 *
 * A task can have several of these records at once, and they disagree in a defined order. Recorded
 * most-authoritative first:
 *
 * 1. **A cancelled or paused run decides.** A run that was stopped is not "working" because a
 *    delivery loop still has an action in it.
 * 2. **A drifted run decides.** `task_run_state`'s `needs_replan` means the pinned inputs changed,
 *    and every downstream reading is about a plan that no longer applies.
 * 3. **A pending approval decides.** `awaiting_approval` is a human decision, and reporting the
 *    loop's next action instead would invite the caller to skip it.
 * 4. **Otherwise the delivery loop's action decides**, which is what `task_run_state` already
 *    computes.
 *
 * The order is the whole content of this module: without it, "what is the state" has as many answers
 * as there are records. The `sources` field names which records were read, so a reader can see the
 * basis rather than trusting the conclusion.
 */
export interface StateView extends JsonObject {
  readonly task_id: string | null;
  readonly status: string;
  /** The single safe next action, or `none`. Never a list: a caller must not choose. */
  readonly action: string;
  /** Who must act next. */
  readonly actor: "none" | "human" | "host";
  /** Which records the answer was read from, so the basis is visible. */
  readonly sources: readonly string[];
  /** Digests and flags only; no business content. */
  readonly workspace: JsonObject | null;
  readonly run: JsonObject | null;
  readonly manifest: JsonObject | null;
}

export class StateViewKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  /**
   * Assemble the view for one task.
   *
   * Every input is optional: a task that has not started has no run, and one that never pinned a
   * manifest has none. A missing record is reported as `null` rather than as a default, because
   * "there is no run" and "there is a run in an unknown state" are different answers and only one of
   * them is a problem.
   */
  get(args: JsonObject): StateView {
    const taskId = args.task_id === undefined ? null : text(args.task_id, "task_id");
    const sources: string[] = [];

    // `store.list` is ordered newest first (`ORDER BY updated_at DESC, id DESC`), so the **first**
    // match is the current record. Taking the last one reported the task's *first* contract and run
    // instead of its current one — which for a re-planned task is exactly the wrong answer, and it
    // looked plausible because a task with one contract has only one record to find.
    const control = taskId === null ? null : this.store.list("task_control_contract", 1_000, (item) => item.task_id === taskId)[0] ?? null;
    if (control) sources.push("task_control_contract");
    const run = control === null ? null : this.store.list("task_run", 1_000, (item) => item.contract_id === control.id)[0] ?? null;
    if (run) sources.push("task_run");
    const runState = run === null ? null : this.store.find("task_run_state", `task_run_state_${String(run.id)}`);
    if (runState) sources.push("task_run_state");
    const launch = control === null ? null : (control.launch_id === undefined || control.launch_id === null ? null : this.store.find("work_launch", String(control.launch_id)));
    if (launch) sources.push("work_launch");
    const loop = launch === null ? null : this.store.find("delivery_loop", `delivery_loop_${String(launch.id)}`);
    if (loop) sources.push("delivery_loop");
    const manifest = launch === null || launch.context_manifest_id === undefined || launch.context_manifest_id === null
      ? null : this.store.find("context_manifest", String(launch.context_manifest_id));
    if (manifest) sources.push("context_manifest");
    // The Workspace snapshot is content-free by design: paths and digests, never business content.
    const workspace = runState === null || runState.observed_workspace_id === undefined
      ? (loop === null || loop.latest_snapshot_id === undefined || loop.latest_snapshot_id === null
        ? null : this.store.find("state_snapshot", String(loop.latest_snapshot_id)))
      : this.store.find("state_snapshot", String(runState.observed_workspace_id));
    if (workspace) sources.push("state_snapshot");

    const decision = this.decide({ run, runState, launch, loop });

    return {
      task_id: taskId,
      status: decision.status,
      action: decision.action,
      actor: decision.actor,
      sources,
      // Projected rather than returned whole: these records carry fields a reader of "state" does not
      // need, and passing them through would make this view a second copy of the schema.
      workspace: workspace === null ? null : {
        id: workspace.id, version: workspace.version, workspace_id: workspace.workspace_id ?? null,
        snapshot_digest: workspace.snapshot_digest ?? null, workspace_state_revision: workspace.workspace_state_revision ?? null,
        is_content_free: workspace.content_free !== false,
      },
      run: run === null ? null : {
        id: run.id, version: run.version, lifecycle: run.lifecycle ?? null,
        stability_digest: run.stability_digest ?? null,
      },
      manifest: manifest === null ? null : {
        id: manifest.id, version: manifest.version, manifest_digest: manifest.manifest_digest ?? null,
      },
    };
  }

  /** The precedence, in one place, so a caller never has to re-derive it. */
  private decide(input: { run: JsonObject | null; runState: JsonObject | null; launch: JsonObject | null; loop: JsonObject | null }): { status: string; action: string; actor: StateView["actor"] } {
    const { run, runState, launch, loop } = input;
    if (run === null) return { status: "not_started", action: "prepare_run", actor: "human" };
    const lifecycle = String(run.lifecycle ?? "");
    // 1. A stopped run is not working, whatever a loop still has queued.
    if (lifecycle === "cancelled") return { status: "cancelled", action: "none", actor: "none" };
    if (lifecycle === "paused") return { status: "paused", action: "resume_or_handoff", actor: "human" };
    if (runState === null) return { status: "running", action: "wait_for_host", actor: "host" };
    const status = String(runState.status ?? "");
    // 2. Drift invalidates every downstream reading, so it is reported before any of them.
    if (status === "needs_replan") return { status, action: "revalidate_inputs", actor: "human" };
    // 3. A pending approval is a human decision; reporting the loop's action instead would invite
    //    the caller to skip it.
    if (status === "awaiting_approval" || launch?.status === "awaiting_approval") {
      return { status: "awaiting_approval", action: "review_work_launch", actor: "human" };
    }
    // 4. Otherwise the run state's own projection decides, and the loop only supplies the action it
    //    already computed.
    const action = String(loop?.action ?? runState.action ?? "wait_for_host");
    return { status: status || "running", action, actor: this.actorOf(action) };
  }

  /** Who acts on an action. Kept beside the precedence so the two cannot drift apart. */
  private actorOf(action: string): StateView["actor"] {
    if (action === "none") return "none";
    if (action === "wait_for_host") return "host";
    return "human";
  }
}
