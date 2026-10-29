import { realpathSync } from "node:fs";
import { getSessionInfo, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { WorkbenchAgentSessionLinks } from "../application/use-cases/workbench-agent-session-links.ts";

type ReadInfo = typeof getSessionInfo;
type ReadMessages = typeof getSessionMessages;

/** Read the provider's transcript directly; never persist it in Craft. */
export class ClaudeWorkbenchHistory {
  readonly links: WorkbenchAgentSessionLinks;
  readonly info: ReadInfo;
  readonly messages: ReadMessages;
  constructor(links: WorkbenchAgentSessionLinks, info: ReadInfo = getSessionInfo, messages: ReadMessages = getSessionMessages) {
    this.links = links; this.info = info; this.messages = messages;
  }

  async read(taskId: string, linkId: string, offset = 0) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("history offset is invalid");
    const link = this.links.get(taskId, linkId);
    if (link.provider !== "claude" || typeof link.native_session_id !== "string" || typeof link.workspace !== "string") throw new Error("session link is not Claude");
    const id = link.native_session_id, cwd = realpathSync(link.workspace);
    const info = await this.info(id, { dir: cwd });
    if (!info || info.sessionId !== id || !info.cwd || realpathSync(info.cwd) !== cwd) throw new Error("Claude session identity or workspace could not be verified");
    const messages = await this.messages(id, { dir: cwd, limit: 101, offset });
    if (messages.some(item => item.session_id !== id)) throw new Error("Claude history contains a different session");
    if (Buffer.byteLength(JSON.stringify(messages)) > 2 * 1024 * 1024) throw new Error("Claude history exceeds display limit");
    return { messages: messages.slice(0, 100), truncated: messages.length > 100, next_offset: messages.length > 100 ? offset + 100 : null };
  }
}
