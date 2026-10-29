import { randomUUID } from "node:crypto";
import { WorkbenchAgentSessionLinks } from "../application/use-cases/workbench-agent-session-links.ts";
import { type CodexServerEvent } from "./codex-app-server-client.ts";
import { CodexWorkbenchAdapter, codexWorkbenchPolicy } from "./codex-workbench-adapter.ts";

type Terminal = { id: string; status: "completed" | "failed" | "interrupted" };

/** Couples one verified native connection to one Task link; event payloads are never persisted. */
export class CodexLinkedTurn {
  readonly links: WorkbenchAgentSessionLinks;
  readonly adapter: CodexWorkbenchAdapter;
  readonly taskId: string;
  readonly linkId: string;
  readonly threadId: string;
  private closed = false;
  private early: Terminal | null = null;
  private diagnostic: string | null = null;

  constructor(links: WorkbenchAgentSessionLinks, adapter: CodexWorkbenchAdapter, taskId: string, linkId: string) {
    const link = links.get(taskId, linkId);
    if (link.provider !== "codex" || typeof link.native_session_id !== "string") throw new Error("session link is not a Codex thread");
    this.links = links; this.adapter = adapter; this.taskId = taskId; this.linkId = linkId; this.threadId = link.native_session_id;
  }

  status() { return { link: this.links.get(this.taskId, this.linkId), connected: !this.closed, diagnostic: this.diagnostic }; }

  async send(prompt: string, skills: Array<{ type: "skill"; name: string; path: string }> = [], mode?: { mode: "plan" | "default"; model: string }, policy?: ReturnType<typeof codexWorkbenchPolicy>) {
    if (this.closed) throw new Error("Codex connection is closed");
    if (typeof prompt !== "string" || !prompt.trim() || prompt.includes("\0") || Buffer.byteLength(prompt) > 60 * 1024) throw new Error("prompt is invalid");
    const operation = randomUUID();
    this.links.reserveTurn(this.taskId, this.linkId, operation);
    this.early = null;
    try {
      const { turn_id: turnId } = await this.adapter.send(this.threadId, prompt, skills, mode, policy);
      const current = this.links.get(this.taskId, this.linkId);
      if (current.turn_state === "unknown") this.links.identifyUnknownTurn(this.taskId, this.linkId, operation, turnId);
      else this.links.acknowledgeTurn(this.taskId, this.linkId, operation, turnId);
      const early = this.early as Terminal | null; // Notifications can arrive while the request awaits its response.
      if (early && early.id === turnId) this.links.completeTurn(this.taskId, this.linkId, operation, turnId, early.status);
      this.early = null;
      return { turn_id: turnId, link: this.links.get(this.taskId, this.linkId) };
    } catch (error) {
      try { this.uncertain(); }
      catch (storageError) { this.diagnostic = storageError instanceof Error ? storageError.message : String(storageError); }
      throw new Error("Codex turn outcome is unknown; reconcile before retrying", { cause: error });
    }
  }

  /** Accept only events delivered by this connection, scoped to its exact native thread. */
  observe(event: CodexServerEvent): void {
    try {
      if (event.type === "closed") { this.closed = true; this.uncertain(); return; }
      if (event.type !== "notification" || event.method !== "turn/completed") return;
      const params = event.params as { threadId?: unknown; turn?: { id?: unknown; status?: unknown } } | null;
      if (!params || params.threadId !== this.threadId || !params.turn || typeof params.turn.id !== "string" || !["completed", "failed", "interrupted"].includes(String(params.turn.status))) return;
      const terminal = { id: params.turn.id, status: params.turn.status as Terminal["status"] };
      const link = this.links.get(this.taskId, this.linkId);
      if (link.turn_state === "starting" || link.turn_state === "unknown" && link.turn_id === null) { this.early = terminal; return; }
      if ((link.turn_state === "running" || link.turn_state === "unknown") && link.turn_id === terminal.id && typeof link.operation_id === "string") {
        this.links.completeTurn(this.taskId, this.linkId, link.operation_id, terminal.id, terminal.status);
      }
    } catch (error) { this.diagnostic = error instanceof Error ? error.message : String(error); }
  }

  private uncertain(): void {
    const link = this.links.get(this.taskId, this.linkId);
    if ((link.turn_state === "starting" || link.turn_state === "running") && typeof link.operation_id === "string") this.links.markTurnUnknown(this.taskId, this.linkId, link.operation_id);
  }
}
