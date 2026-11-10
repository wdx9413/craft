import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { CraftStore, type JsonObject } from "../infrastructure/store.ts";
import { WorkbenchAgentSessionLinks } from "../application/use-cases/workbench-agent-session-links.ts";
import { ClaudeWorkbenchAdapter } from "./claude-workbench-adapter.ts";
import { ClaudeWorkbenchApprovals } from "./claude-workbench-approvals.ts";

type Create = { task_id: string; workspace: string; model?: string | null; permission: "ask" | "read_only" | "auto" | "full"; work_mode?: unknown; operation_id: string; executable: string; prompt: string };
const KIND = "workbench_claude_creation";

/** A creation key is recorded before the first prompt is dispatched to Claude. */
export class ClaudeFirstTurn {
  readonly links: WorkbenchAgentSessionLinks;
  constructor(readonlyStore: CraftStore, readonlyAdapter: ClaudeWorkbenchAdapter) { this.store = readonlyStore; this.adapter = readonlyAdapter; this.links = new WorkbenchAgentSessionLinks(readonlyStore); }
  readonly store: CraftStore; readonly adapter: ClaudeWorkbenchAdapter;

  async start(args: Create, approvals: ClaudeWorkbenchApprovals, onEvent: (event: SDKMessage) => void, abortController?: AbortController): Promise<JsonObject> {
    return this.prepare(args)(approvals, onEvent, abortController);
  }

  /** Reserve synchronously before an HTTP endpoint acknowledges the operation. */
  prepare(args: Create): (approvals: ClaudeWorkbenchApprovals, onEvent: (event: SDKMessage) => void, abortController?: AbortController) => Promise<JsonObject> {
    args = { ...args };
    if (typeof args.operation_id !== "string" || !args.operation_id.trim() || args.operation_id.length > 256 || /[\u0000-\u001f\u007f]/u.test(args.operation_id)) throw new Error("operation_id is invalid");
    if (args.permission !== "ask" && args.permission !== "auto" && args.permission !== "full") throw new Error("Claude read-only permission is not yet verified");
    if (args.work_mode !== undefined && args.work_mode !== "default" && args.work_mode !== "plan") throw new Error("work mode is invalid");
    if (typeof args.prompt !== "string" || !args.prompt.trim() || args.prompt.includes("\0") || Buffer.byteLength(args.prompt) > 60 * 1024) throw new Error("prompt is invalid");
    if (typeof args.workspace !== "string" || !isAbsolute(args.workspace) || !statSync(realpathSync(args.workspace)).isDirectory()) throw new Error("workspace must be an existing absolute directory");
    if (typeof args.executable !== "string" || !isAbsolute(args.executable) || args.executable.includes("\0")) throw new Error("Claude executable must be an absolute path");
    if (args.model != null && (typeof args.model !== "string" || !args.model.trim() || args.model.length > 256 || /[\u0000-\u001f\u007f]/u.test(args.model))) throw new Error("model is invalid");
    this.store.get("task", args.task_id);
    const markerId = `claude_create_${createHash("sha256").update(JSON.stringify([args.task_id, args.operation_id])).digest("hex")}`;
    if (this.store.find(KIND, markerId)) throw new Error("creation operation already used; inspect session before retrying");
    const nativeId = randomUUID(), operation = randomUUID();
    let marker: JsonObject;
    try { marker = this.store.create(KIND, markerId, { task_id: args.task_id, native_session_id: nativeId, status: "starting" }); }
    catch (error) { if (this.store.find(KIND, markerId)) throw new Error("creation operation already used; inspect session before retrying"); throw error; }
    let started = false;
    return (approvals, onEvent, abortController) => {
      if (started) throw new Error("creation operation already started");
      started = true;
      return this.dispatch(args, markerId, marker, nativeId, operation, approvals, onEvent, abortController);
    };
  }

  private async dispatch(args: Create, markerId: string, marker: JsonObject, nativeId: string, operation: string, approvals: ClaudeWorkbenchApprovals, onEvent: (event: SDKMessage) => void, abortController?: AbortController): Promise<JsonObject> {
    let linkId: string | null = null;
    try {
      for await (const event of this.adapter.run({ sessionId: nativeId, workspace: args.workspace, model: args.model, permission: args.permission, workMode: args.work_mode as "default" | "plan" | undefined, executable: args.executable, prompt: args.prompt, resume: false, abortController }, approvals)) {
        if (event.type === "system" && event.subtype === "init") {
          const bound = this.store.transaction(() => {
            const record = this.links.bind({ task_id: args.task_id, provider: "claude", native_session_id: nativeId, workspace: event.cwd, model: event.model, permission: args.permission }).link as JsonObject;
            this.links.reserveTurn(args.task_id, record.id, operation);
            this.links.acknowledgeTurn(args.task_id, record.id, operation, operation);
            this.store.updateIfVersion(KIND, markerId, Number(marker.version), { ...marker, status: "linked", link_id: record.id });
            return record;
          });
          linkId = String(bound.id);
        }
        if (event.type === "result" && linkId) this.links.completeTurn(args.task_id, linkId, operation, operation, event.subtype === "success" && !event.is_error ? "completed" : "failed");
        onEvent(event);
      }
      if (!linkId) throw new Error("Claude session was not established");
      return { link: this.links.get(args.task_id, linkId) };
    } catch (error) {
      if (linkId) try {
        const link = this.links.get(args.task_id, linkId);
        if (link.operation_id === operation && (link.turn_state === "starting" || link.turn_state === "running")) this.links.markTurnUnknown(args.task_id, linkId, operation);
      } catch { /* The original failure must not be presented as safe to retry. */ }
      throw new Error("Claude creation outcome may be unknown; inspect native session before retrying", { cause: error });
    }
  }
}
