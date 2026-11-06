import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "../infrastructure/store.ts";
import { WorkbenchAgentSessionLinks } from "../application/use-cases/workbench-agent-session-links.ts";

const KIND = "workbench_message_queue";

/** Unsent prompts are durable. A claimed prompt is never automatically replayed. */
export class WorkbenchMessageQueue {
  readonly links: WorkbenchAgentSessionLinks;
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; this.links = new WorkbenchAgentSessionLinks(store); }

  list(task: string, link: string): JsonObject[] {
    this.links.get(task, link);
    return this.store.readSnapshot(() => {
      const rows = this.store.database.prepare(`SELECT r.id FROM records r
        WHERE r.kind=? AND json_extract(r.payload_json,'$.task_id')=? AND json_extract(r.payload_json,'$.link_id')=?
        AND json_extract(r.payload_json,'$.state')!='sent'
        AND NOT EXISTS (SELECT 1 FROM records newer WHERE newer.kind=r.kind AND newer.id=r.id AND newer.version>r.version)
        ORDER BY CAST(json_extract(r.payload_json,'$.sequence') AS INTEGER),r.id LIMIT 1000`).all(KIND, task, link) as Array<{ id: string }>;
      return rows.map(row => this.store.get(KIND, row.id));
    });
  }

  enqueue(task: string, link: string, prompt: string, workMode?: unknown): JsonObject {
    this.links.get(task, link);
    if (typeof prompt !== "string" || !prompt.trim() || prompt.includes("\0") || Buffer.byteLength(prompt) > 60 * 1024) throw new Error("prompt is invalid");
    if (workMode !== undefined && workMode !== "default" && workMode !== "plan") throw new Error("work mode is invalid");
    return this.store.transaction(() => {
      if (this.list(task, link).length >= 100) throw new Error("queue is full");
      const id = randomUUID();
      const counter = this.store.find("workbench_message_queue_counter", link);
      const sequence = Number(counter?.sequence ?? 0) + 1;
      if (!Number.isSafeInteger(sequence)) throw new Error("queue sequence exhausted");
      if (counter) this.store.updateIfVersion("workbench_message_queue_counter", link, Number(counter.version), { sequence });
      else this.store.create("workbench_message_queue_counter", link, { sequence });
      return this.store.create(KIND, id, { task_id: task, link_id: link, prompt, state: "queued", operation_id: id, sequence, ...(workMode === undefined ? {} : { work_mode: workMode }) });
    });
  }

  private get(task: string, link: string, id: string): JsonObject {
    this.links.get(task, link);
    const record = this.store.get(KIND, id);
    if (record.task_id !== task || record.link_id !== link) throw new Error("queue item does not belong to session");
    return record;
  }

  cancel(task: string, link: string, id: string): void {
    this.store.transaction(() => { const item = this.get(task, link, id); if (item.state !== "queued") throw new Error("queue item is not pending"); this.store.remove(KIND, id); });
  }

  edit(task: string, link: string, id: string, prompt: string): JsonObject {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.includes("\0") || Buffer.byteLength(prompt) > 60 * 1024) throw new Error("prompt is invalid");
    return this.store.transaction(() => {
      const item = this.get(task, link, id);
      if (item.state !== "queued") throw new Error("queue item is not pending");
      return this.store.updateIfVersion(KIND, id, Number(item.version), { ...item, prompt });
    });
  }

  claim(task: string, link: string, id: string): JsonObject {
    return this.store.transaction(() => {
      const session = this.links.get(task, link); const item = this.get(task, link, id);
      if (session.turn_state !== "idle" || item.state !== "queued") throw new Error("queue dispatch is not safe");
      const queue = this.list(task, link);
      if (queue[0]?.id !== id || queue.some(row => row.state === "dispatching" || row.state === "unknown")) throw new Error("queue is blocked");
      return this.store.updateIfVersion(KIND, id, Number(item.version), { ...item, state: "dispatching", dispatch_owner_pid: process.pid });
    });
  }

  claimSteer(task: string, link: string, id: string): JsonObject {
    return this.store.transaction(() => {
      const session = this.links.get(task, link); const item = this.get(task, link, id);
      if (session.provider !== "codex" || session.turn_state !== "running" || item.state !== "queued") throw new Error("queue steering is not available");
      if (this.list(task, link).some(row => row.state === "dispatching" || row.state === "unknown")) throw new Error("queue is blocked");
      return this.store.updateIfVersion(KIND, id, Number(item.version), { ...item, state: "dispatching", dispatch_owner_pid: process.pid });
    });
  }

  settle(task: string, link: string, id: string, accepted: boolean): JsonObject {
    return this.store.transaction(() => {
      const item = this.get(task, link, id);
      if (item.state !== "dispatching") throw new Error("queue item is not dispatching");
      if (!accepted) return this.store.updateIfVersion(KIND, id, Number(item.version), { ...item, state: "unknown" });
      // Versioned updates retain previous payloads. Keep a content-free receipt
      // and remove every pending-input revision in the same short transaction.
      const receipt = this.store.create("workbench_message_queue_receipt", id, {
        task_id: task, link_id: link, operation_id: item.operation_id, sequence: item.sequence, state: "sent",
      });
      this.store.remove(KIND, id);
      return receipt;
    });
  }

  /** Retire only legacy items whose latest revision already confirms acceptance. */
  retireLegacySent(limit = 25): number {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("retirement limit must be 1..100");
    const candidates = this.store.list(KIND, limit, row => row.state === "sent");
    let retired = 0;
    for (const candidate of candidates) this.store.transaction(() => {
      const item = this.store.find(KIND, String(candidate.id));
      if (!item || item.version !== candidate.version || item.state !== "sent") return;
      const prior = this.store.find("workbench_message_queue_receipt", String(item.id));
      if (prior && (prior.task_id !== item.task_id || prior.link_id !== item.link_id || prior.operation_id !== item.operation_id)) throw new Error("queue receipt identity conflict");
      if (!prior) this.store.create("workbench_message_queue_receipt", String(item.id), {
        task_id: item.task_id, link_id: item.link_id, operation_id: item.operation_id, sequence: item.sequence, state: "sent",
      });
      this.store.remove(KIND, String(item.id));
      retired++;
    });
    return retired;
  }
}
