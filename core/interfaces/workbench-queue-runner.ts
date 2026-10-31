import { CraftStore, type JsonObject } from "../infrastructure/store.ts";
import { WorkbenchMessageQueue } from "./workbench-message-queue.ts";

/** Server-owned dispatch; durable claims in the queue remain the cross-client fence. */
export class WorkbenchQueueRunner {
  private timer: NodeJS.Timeout | undefined;
  private pending: Promise<void> | undefined;
  private stopped = false;
  private legacyRetired = false;
  private afterLink = "";
  readonly store: CraftStore;
  readonly dispatch: (task: string, link: string) => Promise<unknown>;
  readonly available: (link: JsonObject) => boolean;
  constructor(store: CraftStore, dispatch: (task: string, link: string) => Promise<unknown>, available: (link: JsonObject) => boolean = () => true) {
    this.store = store; this.dispatch = dispatch; this.available = available;
  }

  start(): void {
    if (this.timer || this.stopped) return;
    this.timer = setInterval(() => { void this.tick(); }, 500);
    this.timer.unref();
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.drain().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async drain(): Promise<void> {
    try {
      if (!this.legacyRetired) this.legacyRetired = await this.store.transactionWithRetry(() => new WorkbenchMessageQueue(this.store).retireLegacySent()) < 25;
      // Page session identities rather than prompt bodies. A busy session's
      // backlog must neither consume the whole scan nor starve later sessions.
      const rows = this.store.readSnapshot(database => database.prepare(`SELECT DISTINCT
        json_extract(r.payload_json,'$.task_id') task_id,json_extract(r.payload_json,'$.link_id') link_id
        FROM records r WHERE r.kind='workbench_message_queue'
        AND json_extract(r.payload_json,'$.state')='queued'
        AND json_extract(r.payload_json,'$.link_id')>?
        AND NOT EXISTS (SELECT 1 FROM records newer WHERE newer.kind=r.kind AND newer.id=r.id AND newer.version>r.version)
        ORDER BY link_id,task_id LIMIT 101`).all(this.afterLink)) as Array<{ task_id: string; link_id: string }>;
      this.afterLink = rows.length > 100 ? rows[99].link_id : "";
      const seen = new Set<string>();
      for (const row of rows.slice(0, 100)) {
        if (this.stopped) break;
        const task = String(row.task_id), id = String(row.link_id);
        if (seen.has(id)) continue;
        try {
          const link = this.store.get("workbench_agent_session_link", id);
          if (link.task_id !== task || link.turn_state !== "idle" || ["failed", "interrupted"].includes(String(link.last_turn_status)) || !this.available(link)) continue;
          seen.add(id);
          await this.dispatch(task, id);
        } catch { /* Keep pending/unknown claims intact; one blocked session cannot stop others. */ }
      }
    } catch { /* Storage contention is retried by the next bounded scan. */ }
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}
