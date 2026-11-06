import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { query, type Options, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeWorkbenchApprovals } from "./claude-workbench-approvals.ts";

type Query = AsyncIterable<SDKMessage> & { close(): void };
type Launch = (args: { prompt: string; options: Options }) => Query;
type Turn = { sessionId: string; workspace: string; prompt: string; model?: string | null; resume: boolean; permission: "ask" | "read_only" | "auto" | "full"; workMode?: "default" | "plan"; executable: string; abortController?: AbortController };
const normalizeModel = (model: string) => model.replace(/\[(\d+)M\]$/u, "[$1m]");

/** Provider transport only. The caller owns durable turn reservations and event delivery. */
export class ClaudeWorkbenchAdapter {
  readonly launch: Launch;
  constructor(launch: Launch = query) { this.launch = launch; }

  async *run(turn: Turn, approvals: ClaudeWorkbenchApprovals): AsyncGenerator<SDKMessage> {
    if (turn.abortController?.signal.aborted) throw new Error("Claude request was cancelled");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(turn.sessionId)) throw new Error("Claude session id is invalid");
    if (turn.permission !== "ask" && turn.permission !== "auto" && turn.permission !== "full") throw new Error("Claude read-only permission is not yet verified");
    if (typeof turn.workspace !== "string" || !isAbsolute(turn.workspace)) throw new Error("workspace must be absolute");
    const cwd = realpathSync(turn.workspace);
    if (!statSync(cwd).isDirectory()) throw new Error("workspace must be a directory");
    if (typeof turn.executable !== "string" || !isAbsolute(turn.executable) || turn.executable.includes("\0")) throw new Error("Claude executable must be an absolute path");
    if (typeof turn.prompt !== "string" || !turn.prompt.trim() || turn.prompt.includes("\0") || Buffer.byteLength(turn.prompt) > 60 * 1024) throw new Error("prompt is invalid");
    if (turn.model != null && (typeof turn.model !== "string" || !turn.model.trim() || turn.model.length > 256 || /[\u0000-\u001f\u007f]/u.test(turn.model))) throw new Error("model is invalid");
    if (turn.workMode !== undefined && turn.workMode !== "default" && turn.workMode !== "plan") throw new Error("work mode is invalid");
    const mode = turn.workMode === "plan" ? "plan" : turn.permission === "full" ? "bypassPermissions" : turn.permission === "auto" ? "auto" : "default";
    const options: Options = { cwd, model: turn.model ?? undefined, permissionMode: mode, ...(mode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}), settingSources: ["user", "project", "local"], persistSession: true, includePartialMessages: true, tools: { type: "preset", preset: "claude_code" }, canUseTool: approvals.canUseTool, pathToClaudeCodeExecutable: turn.executable, abortController: turn.abortController, ...(turn.resume ? { resume: turn.sessionId } : { sessionId: turn.sessionId }) };
    const running = this.launch({ prompt: turn.prompt, options });
    let initialized = false; let terminal = false;
    try {
      for await (const event of running) {
        if (event.session_id !== turn.sessionId) throw new Error("Claude event belongs to a different session");
        if (!initialized) {
          // Claude Code can report startup hooks before it reports effective settings.
          if (event.type === "system" && ["hook_started", "hook_progress", "hook_response"].includes(event.subtype)) continue;
          if (event.type !== "system" || event.subtype !== "init") throw new Error("Claude initialization event is missing");
          if (realpathSync(event.cwd) !== cwd || event.permissionMode !== mode || (turn.model != null && !["default", "opus", "sonnet", "haiku", "fable"].includes(turn.model) && normalizeModel(event.model) !== normalizeModel(turn.model))) throw new Error("Claude effective settings do not match requested settings");
          initialized = true;
        }
        if (event.type === "result") terminal = true;
        yield event;
      }
      if (!initialized || !terminal) throw new Error("Claude turn outcome is unknown");
    } finally { approvals.close(); running.close(); }
  }
}
