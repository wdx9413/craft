import { CraftStore } from "../infrastructure/store.ts";
import { ClaudeFirstTurn } from "./claude-first-turn.ts";
import { ClaudeRunRegistry } from "./claude-run-registry.ts";
import { ClaudeWorkbenchAdapter } from "./claude-workbench-adapter.ts";
import { ClaudeLinkedTurn } from "./claude-linked-turn.ts";

/** Coordinates durable first-turn reservation with the ephemeral event stream. */
export class ClaudeWorkbenchRuns {
  readonly first: ClaudeFirstTurn;
  readonly registry: ClaudeRunRegistry;
  readonly adapter: ClaudeWorkbenchAdapter;
  constructor(store: CraftStore, adapter = new ClaudeWorkbenchAdapter(), registry = new ClaudeRunRegistry()) {
    this.first = new ClaudeFirstTurn(store, adapter); this.registry = registry; this.adapter = adapter;
  }
  send(args: { task_id: string; link_id: string; prompt: string; operation_id: string; executable: string; work_mode?: unknown }) {
    const runner = new ClaudeLinkedTurn(this.first.links, this.adapter, args.task_id, args.link_id);
    let dispatch!: ReturnType<ClaudeLinkedTurn["prepare"]>;
    const runId = this.registry.start(args.task_id, (approvals, emit, abort) => dispatch(approvals, emit, abort), () => { dispatch = runner.prepare(args.prompt, args.executable, true, args.operation_id, args.work_mode); });
    return { run_id: runId };
  }

  create(args: Parameters<ClaudeFirstTurn["prepare"]>[0]) {
    let dispatch!: ReturnType<ClaudeFirstTurn["prepare"]>;
    const runId = this.registry.start(args.task_id, async (approvals, emit, abort) => { await dispatch(approvals, emit, abort); }, () => { dispatch = this.first.prepare(args); });
    return { run_id: runId };
  }
  close(): void { this.registry.close(); }
}
