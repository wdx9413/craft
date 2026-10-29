import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { WorkbenchAgentSessionLinks } from "../application/use-cases/workbench-agent-session-links.ts";
import { ClaudeWorkbenchAdapter } from "./claude-workbench-adapter.ts";
import { ClaudeWorkbenchApprovals } from "./claude-workbench-approvals.ts";

/** A client-generated turn identity is local metadata, not a Claude message. */
export class ClaudeLinkedTurn {
  readonly links: WorkbenchAgentSessionLinks; readonly adapter: ClaudeWorkbenchAdapter; readonly taskId: string; readonly linkId: string;
  constructor(links: WorkbenchAgentSessionLinks, adapter: ClaudeWorkbenchAdapter, taskId: string, linkId: string) {
    const link = links.get(taskId, linkId);
    if (link.provider !== "claude" || typeof link.native_session_id !== "string") throw new Error("session link is not Claude");
    this.links = links; this.adapter = adapter; this.taskId = taskId; this.linkId = linkId;
  }

  async send(prompt: string, executable: string, resume: boolean, approvals: ClaudeWorkbenchApprovals, onEvent: (event: SDKMessage) => void, abortController?: AbortController): Promise<void> {
    return this.prepare(prompt, executable, resume, randomUUID())(approvals, onEvent, abortController);
  }

  prepare(prompt: string, executable: string, resume: boolean, submissionId: string, workMode?: unknown): (approvals: ClaudeWorkbenchApprovals, onEvent: (event: SDKMessage) => void, abortController?: AbortController) => Promise<void> {
    const link = this.links.get(this.taskId, this.linkId);
    if (typeof prompt !== "string" || !prompt.trim() || prompt.includes("\0") || Buffer.byteLength(prompt) > 60 * 1024) throw new Error("prompt is invalid");
    if (link.permission !== "ask" && link.permission !== "auto" && link.permission !== "full") throw new Error("Claude read-only permission is not yet verified");
    if (typeof executable !== "string" || !isAbsolute(executable) || executable.includes("\0")) throw new Error("Claude executable must be an absolute path");
    if (typeof submissionId !== "string" || !submissionId.trim() || submissionId.length > 256 || /[\u0000-\u001f\u007f]/u.test(submissionId)) throw new Error("operation_id is invalid");
    if (workMode !== undefined && workMode !== "default" && workMode !== "plan") throw new Error("work mode is invalid");
    const operation = randomUUID();
    const id = `claude_submit_${createHash("sha256").update(JSON.stringify([this.taskId, this.linkId, submissionId])).digest("hex")}`;
    this.links.store.transaction(() => {
      if (this.links.store.find("workbench_claude_submission", id)) throw new Error("submission operation already used; inspect session before retrying");
      this.links.store.create("workbench_claude_submission", id, { task_id: this.taskId, link_id: this.linkId, status: "reserved" });
      this.links.reserveTurn(this.taskId, this.linkId, operation);
    });
    let started = false;
    return (approvals, onEvent, abortController) => {
      if (started) throw new Error("submission operation already started");
      started = true;
      return this.dispatch(link, prompt, executable, resume, operation, approvals, onEvent, abortController, workMode as "default" | "plan" | undefined);
    };
  }

  private async dispatch(link: Record<string, unknown>, prompt: string, executable: string, resume: boolean, operation: string, approvals: ClaudeWorkbenchApprovals, onEvent: (event: SDKMessage) => void, abortController?: AbortController, workMode?: "default" | "plan"): Promise<void> {
    try {
      for await (const event of this.adapter.run({ sessionId: String(link.native_session_id), workspace: String(link.workspace), model: link.model as string | null, permission: link.permission as "ask" | "read_only" | "auto" | "full", workMode, prompt, executable, resume, abortController }, approvals)) {
        if (event.type === "system" && event.subtype === "init") this.links.acknowledgeTurn(this.taskId, this.linkId, operation, operation);
        if (event.type === "result") this.links.completeTurn(this.taskId, this.linkId, operation, operation, event.subtype === "success" && !event.is_error ? "completed" : "failed");
        onEvent(event);
      }
    } catch (error) {
      try {
        const current = this.links.get(this.taskId, this.linkId);
        if (current.operation_id === operation && (current.turn_state === "starting" || current.turn_state === "running")) this.links.markTurnUnknown(this.taskId, this.linkId, operation);
      } catch { /* A storage failure must never claim that retry is safe. */ }
      throw new Error("Claude turn outcome may be unknown; inspect the native session before retrying", { cause: error });
    }
  }
}
