import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { type CodexAppServerClient } from "./codex-app-server-client.ts";

type Rpc = Pick<CodexAppServerClient, "request" | "respond">;
type Permission = "read_only" | "ask" | "auto" | "full";
type Options = { workspace: string; model?: string | null; permission: Permission };

function nonempty(value: unknown, label: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error(`${label} is invalid`);
  return value;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid Codex ${label}`);
  return value as Record<string, unknown>;
}
export function codexWorkbenchPolicy(options: Options) {
  if (options.permission !== "read_only" && options.permission !== "ask" && options.permission !== "auto" && options.permission !== "full") throw new Error("Unsupported Codex permission");
  const workspace = nonempty(options.workspace, "workspace", 4096);
  if (!isAbsolute(workspace)) throw new Error("workspace must be absolute");
  const cwd = realpathSync(workspace);
  if (!statSync(cwd).isDirectory()) throw new Error("workspace must be a directory");
  const model = options.model == null ? null : nonempty(options.model, "model", 256);
  return { cwd, model, sandbox: (options.permission === "ask" || options.permission === "auto") ? "workspace-write" : options.permission === "full" ? "danger-full-access" : "read-only", approvalPolicy: (options.permission === "ask" || options.permission === "auto") ? "on-request" : "never", ...(options.permission === "auto" ? { approvalsReviewer: "auto_review" } : options.permission === "ask" ? { approvalsReviewer: "user" } : {}) };
}

/** Provider calls only; the caller owns session association, event delivery and approval ownership. */
export class CodexWorkbenchAdapter {
  readonly rpc: Rpc;
  constructor(rpc: Rpc) { this.rpc = rpc; }

  private check(value: unknown, expected: ReturnType<typeof codexWorkbenchPolicy>, threadId?: string) {
    const result = object(value, "thread response");
    const thread = object(result.thread, "thread");
    const id = nonempty(thread.id, "thread id", 512);
    if (threadId !== undefined && id !== threadId) throw new Error("Codex resumed a different thread");
    if (thread.ephemeral !== false) throw new Error("Codex thread is not persistent");
    const sandbox = object(result.sandbox, "sandbox");
    const expectedType = expected.sandbox === "workspace-write" ? "workspaceWrite" : expected.sandbox === "danger-full-access" ? "dangerFullAccess" : "readOnly";
    if (sandbox.type !== expectedType || (expectedType !== "dangerFullAccess" && sandbox.networkAccess !== undefined && sandbox.networkAccess !== false) || (expectedType === "workspaceWrite" && sandbox.writableRoots !== undefined && (!Array.isArray(sandbox.writableRoots) || sandbox.writableRoots.length !== 0)) || result.approvalPolicy !== expected.approvalPolicy || (expected.approvalsReviewer !== undefined && result.approvalsReviewer !== expected.approvalsReviewer)) throw new Error("Codex effective permissions do not match requested policy");
    if (typeof result.cwd !== "string" || realpathSync(result.cwd) !== expected.cwd) throw new Error("Codex workspace does not match requested workspace");
    const model = nonempty(result.model, "model", 256);
    if (expected.model !== null && model !== expected.model) throw new Error("Codex model does not match selected model");
    return { thread_id: id, model, workspace: expected.cwd, sandbox: expected.sandbox, approval_policy: expected.approvalPolicy };
  }

  async start(options: Options) {
    const selected = codexWorkbenchPolicy(options);
    const result = await this.rpc.request("thread/start", { ...selected, ephemeral: false });
    return this.check(result, selected);
  }

  async resume(threadId: string, options: Options) {
    const id = nonempty(threadId, "thread id", 512);
    const selected = codexWorkbenchPolicy(options);
    const result = await this.rpc.request("thread/resume", { threadId: id, ...selected });
    return this.check(result, selected, id);
  }

  async send(threadId: string, prompt: string, skills: Array<{ type: "skill"; name: string; path: string }> = [], mode?: { mode: "plan" | "default"; model: string }, policy?: ReturnType<typeof codexWorkbenchPolicy>) {
    const id = nonempty(threadId, "thread id", 512);
    if (typeof prompt !== "string" || !prompt.trim() || prompt.includes("\0") || Buffer.byteLength(prompt) > 60 * 1024) throw new Error("prompt is invalid");
    const sandboxType = policy?.sandbox === "workspace-write" ? "workspaceWrite" : policy?.sandbox === "danger-full-access" ? "dangerFullAccess" : "readOnly";
    const result = object(await this.rpc.request("turn/start", { threadId: id, input: [{ type: "text", text: prompt }, ...skills], ...(mode ? { collaborationMode: { mode: mode.mode, settings: { model: mode.model } } } : {}), ...(policy ? { model: policy.model, approvalPolicy: policy.approvalPolicy, approvalsReviewer: policy.approvalsReviewer ?? "user", sandboxPolicy: { type: sandboxType } } : {}) }), "turn response");
    return { turn_id: nonempty(object(result.turn, "turn").id, "turn id", 512) };
  }

  async steer(threadId: string, turnId: string, prompt: string, skills: Array<{ type: "skill"; name: string; path: string }> = []) {
    if (typeof prompt !== "string" || !prompt.trim() || prompt.includes("\0") || Buffer.byteLength(prompt) > 60 * 1024) throw new Error("prompt is invalid");
    return this.rpc.request("turn/steer", { threadId: nonempty(threadId, "thread id", 512), expectedTurnId: nonempty(turnId, "turn id", 512), input: [{ type: "text", text: prompt }, ...skills] });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.rpc.request("turn/interrupt", { threadId: nonempty(threadId, "thread id", 512), turnId: nonempty(turnId, "turn id", 512) });
  }

  async history(threadId: string) {
    const id = nonempty(threadId, "thread id", 512);
    const result = object(await this.rpc.request("thread/read", { threadId: id, includeTurns: true }), "history response");
    const thread = object(result.thread, "thread");
    if (thread.id !== id) throw new Error("Codex history belongs to a different thread");
    return thread;
  }

  decide(requestId: string | number, decision: "accept" | "decline"): void {
    if (decision !== "accept" && decision !== "decline") throw new Error("Unsupported approval decision");
    this.rpc.respond(requestId, { decision });
  }
}
