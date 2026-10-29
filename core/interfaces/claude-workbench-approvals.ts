import { randomUUID } from "node:crypto";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";

type Pending = { id: string; tool: string; input: Record<string, unknown>; context: Record<string, unknown>; resolve: (value: PermissionResult) => void; signal: AbortSignal; abort: () => void };

/** Permission prompts live only in memory and resolve exactly once. */
export class ClaudeWorkbenchApprovals {
  private pending = new Map<string, Pending>();
  private closed = false;
  readonly onChange: () => void;
  constructor(onChange: () => void = () => {}) { this.onChange = onChange; }

  readonly canUseTool: CanUseTool = async (tool, input, options) => {
    if (this.closed || options.signal.aborted) return { behavior: "deny", message: "Approval is unavailable" };
    const context = { title: options.title, description: options.description, blockedPath: options.blockedPath, decisionReason: options.decisionReason, mcpServer: options.mcpServer, defaultToNo: options.defaultToNo };
    let snapshot: { input: Record<string, unknown>; context: Record<string, unknown> };
    try { const serialized = JSON.stringify({ input, context }); if (this.pending.size >= 32 || Buffer.byteLength(serialized) > 256 * 1024) return { behavior: "deny", message: "Approval request cannot be displayed" }; snapshot = JSON.parse(serialized); if (tool === "AskUserQuestion") questionTexts(snapshot.input); }
    catch { return { behavior: "deny", message: "Approval request cannot be displayed" }; }
    const id = randomUUID();
    return new Promise<PermissionResult>(resolve => {
      const abort = () => this.finish(id, { behavior: "deny", message: "Approval was cancelled" });
      this.pending.set(id, { id, tool, input: snapshot.input, context: snapshot.context, resolve, signal: options.signal, abort });
      options.signal.addEventListener("abort", abort, { once: true });
      if (options.signal.aborted) abort(); else this.onChange();
    });
  };

  list() { return [...this.pending.values()].map(({ id, tool, input, context }) => ({ id, tool, input: structuredClone(input), context: structuredClone(context) })); }

  decide(id: string, decision: "accept" | "decline", answers?: unknown): void {
    const entry = this.pending.get(id);
    if (!entry) throw new Error("approval is not pending");
    if (decision !== "accept" && decision !== "decline") throw new Error("approval decision is invalid");
    if (decision === "accept" && entry.tool === "AskUserQuestion") {
      const questions = questionTexts(entry.input);
      if (!answers || typeof answers !== "object" || Array.isArray(answers) || Object.keys(answers).length !== questions.length) throw new Error("question answers are invalid");
      const submitted = answers as Record<string, unknown>;
      if (questions.some(q => !Object.hasOwn(submitted, q) || typeof submitted[q] !== "string" || !(submitted[q] as string).trim() || Buffer.byteLength(submitted[q] as string) > 8192)) throw new Error("question answers are invalid");
      this.finish(id, { behavior: "allow", updatedInput: { ...entry.input, answers: Object.fromEntries(questions.map(q => [q, submitted[q]])) } });
      return;
    }
    this.finish(id, decision === "accept" ? { behavior: "allow", updatedInput: entry.input } : { behavior: "deny", message: "User declined" });
  }

  private finish(id: string, result: PermissionResult): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id); entry.signal.removeEventListener("abort", entry.abort); entry.resolve(result); this.onChange();
  }

  close(): void {
    this.closed = true;
    for (const id of [...this.pending.keys()]) this.finish(id, { behavior: "deny", message: "Session closed" });
  }
}

function questionTexts(input: Record<string, unknown>): string[] {
  const questions = input.questions;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > 4) throw new Error("questions are invalid");
  const texts = questions.map(q => q && typeof q === "object" && typeof q.question === "string" ? q.question : "");
  if (texts.some(q => !q.trim()) || new Set(texts).size !== texts.length) throw new Error("questions are invalid");
  return texts;
}
