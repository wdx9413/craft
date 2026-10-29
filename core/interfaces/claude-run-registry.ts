import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeWorkbenchApprovals } from "./claude-workbench-approvals.ts";

type EventRow = { sequence: number; event: SDKMessage; size: number };
type Run = { taskId: string; nativeSessionId: string | null; abort: AbortController; approvals: ClaudeWorkbenchApprovals; state: "running" | "completed" | "unknown"; reason: string | null; rows: EventRow[]; bytes: number; sequence: number };

function failureReason(error: unknown): string {
  let current: unknown = error;
  for (let i = 0; i < 5 && current instanceof Error; i++, current = current.cause) {
    if (current.message === "Claude effective settings do not match requested settings") return "settings_mismatch";
    if (current.message === "Claude initialization event is missing") return "initialization_missing";
    if (current.message === "Claude event belongs to a different session") return "session_mismatch";
  }
  return "unknown";
}

/** Ephemeral delivery only. Durable session and turn state belongs to the link store. */
export class ClaudeRunRegistry {
  private runs = new Map<string, Run>();
  private closed = false;

  start(taskId: string, execute: (approvals: ClaudeWorkbenchApprovals, emit: (event: SDKMessage) => void, abort: AbortController) => Promise<void>, prepare: () => void = () => {}): string {
    if (this.closed) throw new Error("Claude run registry is closed");
    if (typeof taskId !== "string" || !taskId.trim()) throw new Error("task_id is invalid");
    if (this.runs.size >= 64) throw new Error("Claude run registry is full");
    prepare();
    const id = randomUUID(); const abort = new AbortController(); const approvals = new ClaudeWorkbenchApprovals();
    const run: Run = { taskId, nativeSessionId: null, abort, approvals, state: "running", reason: null, rows: [], bytes: 0, sequence: 0 };
    this.runs.set(id, run);
    const emit = (event: SDKMessage) => {
      if (abort.signal.aborted) throw new Error("Claude run was cancelled");
      if (typeof event.session_id === "string") {
        if (run.nativeSessionId !== null && run.nativeSessionId !== event.session_id) { abort.abort(); throw new Error("Claude run changed session"); }
        run.nativeSessionId = event.session_id;
      }
      const size = Buffer.byteLength(JSON.stringify(event));
      if (size > 256 * 1024) { abort.abort(); throw new Error("Claude event exceeds display limit"); }
      run.rows.push({ sequence: ++run.sequence, event, size }); run.bytes += size;
      while (run.rows.length > 256 || run.bytes > 2 * 1024 * 1024) run.bytes -= run.rows.shift()!.size;
    };
    void Promise.resolve().then(() => execute(approvals, emit, abort)).then(() => { run.state = abort.signal.aborted ? "unknown" : "completed"; }, error => { run.state = "unknown"; run.reason = failureReason(error); }).finally(() => approvals.close());
    return id;
  }

  private get(taskId: string, id: string): Run {
    const run = this.runs.get(id);
    if (!run || run.taskId !== taskId) throw new Error("Claude run not found for task");
    return run;
  }

  list(taskId: string) {
    return [...this.runs.entries()].filter(([, run]) => run.taskId === taskId).map(([id, run]) => ({ run_id: id, state: run.state, native_session_id: run.nativeSessionId }));
  }

  events(taskId: string, id: string, after: number) {
    const run = this.get(taskId, id);
    if (!Number.isSafeInteger(after) || after < 0 || after > run.sequence) throw new Error("event cursor is invalid");
    const oldest = run.rows[0]?.sequence ?? run.sequence + 1;
    return { state: run.state, reason: run.reason, native_session_id: run.nativeSessionId, events: run.rows.filter(row => row.sequence > after).map(({ sequence, event }) => ({ sequence, event })), last_sequence: run.sequence, truncated: after < oldest - 1, approvals: run.approvals.list() };
  }

  decide(taskId: string, id: string, requestId: string, decision: "accept" | "decline", answers?: unknown): void { this.get(taskId, id).approvals.decide(requestId, decision, answers); }
  interrupt(taskId: string, id: string): void { const run = this.get(taskId, id); if (run.state !== "running") throw new Error("Claude run is not active"); run.abort.abort(); run.approvals.close(); }
  release(taskId: string, id: string): void { const run = this.get(taskId, id); if (run.state === "running") throw new Error("Claude run is still active"); this.runs.delete(id); }
  close(): void { this.closed = true; for (const run of this.runs.values()) { run.abort.abort(); run.approvals.close(); } }
}
