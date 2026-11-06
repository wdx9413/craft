import { createHash } from "node:crypto";
import { getSessionInfo, listSessions } from "@anthropic-ai/claude-agent-sdk";
import { WorkbenchAgentSessionLinks } from "../application/use-cases/workbench-agent-session-links.ts";
import type { JsonObject } from "../infrastructure/store.ts";

const validId = (id: unknown): id is string => typeof id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export class ClaudeNativeSessions {
  readonly links: WorkbenchAgentSessionLinks;
  readonly listNative: typeof listSessions;
  readonly readNative: typeof getSessionInfo;
  constructor(links: WorkbenchAgentSessionLinks, listNative = listSessions, readNative = getSessionInfo) { this.links = links; this.listNative = listNative; this.readNative = readNative; }

  async list(offset: number): Promise<JsonObject> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("session offset is invalid");
    const rows = await this.listNative({ limit: 51, offset });
    if (!Array.isArray(rows) || rows.length > 51) throw new Error("Invalid Claude session list");
    const threads = rows.slice(0, 50).filter(row => validId(row.sessionId) && typeof row.cwd === "string" && row.cwd.length <= 4096).map(row => {
      const key = `agent_session_${createHash("sha256").update(JSON.stringify(["claude", row.sessionId])).digest("hex")}`;
      const link = this.links.store.find("workbench_agent_session_link", key);
      return { id: row.sessionId, workspace: row.cwd, title: (row.customTitle || row.summary || row.firstPrompt || "Claude 会话").slice(0, 160), updated_at: row.lastModified, linked_task_id: link?.task_id ?? null, linked_id: link?.id ?? null };
    });
    return { threads, next_cursor: rows.length > 50 ? String(offset + 50) : null };
  }

  async import(taskId: string, id: string, model: unknown, permission: unknown): Promise<JsonObject> {
    this.links.store.get("task", taskId);
    if (!validId(id)) throw new Error("Claude session id is invalid");
    if (permission !== "ask" && permission !== "auto" && permission !== "full") throw new Error("Claude permission is invalid");
    if (model !== null && (typeof model !== "string" || !model.trim() || model.length > 256 || /[\u0000-\u001f\u007f]/u.test(model))) throw new Error("model is invalid");
    const info = await this.readNative(id);
    if (!info || info.sessionId !== id || typeof info.cwd !== "string") throw new Error("Claude session identity or workspace could not be verified");
    return this.links.bind({ task_id: taskId, provider: "claude", native_session_id: id, workspace: info.cwd, model, permission });
  }
}
