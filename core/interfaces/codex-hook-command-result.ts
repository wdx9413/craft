import { closeSync, constants, fstatSync, openSync, readSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isHookVerificationCommand, nestedText } from "./codex-hook-signal-sanitizer.ts";

const MAX_TRANSCRIPT_TAIL_BYTES = 512 * 1024;

type HookInput = Record<string, unknown>;
export const NATIVE_ASYNC_COMPLETION = Symbol("craft-native-async-completion");
const verifiedCodexCompletions = new WeakSet<object>();

export function isVerifiedCodexCommandCompletion(input: object): boolean {
  return verifiedCodexCompletions.has(input);
}

export function carryVerifiedCodexCommandCompletion(source: object, target: object): void {
  if (verifiedCodexCompletions.has(source)) verifiedCodexCompletions.add(target);
}
type CommandCompletion = {
  type?: string;
  payload?: {
    type?: string;
    thread_id?: string;
    turn_id?: string;
    item?: { type?: string; id?: string; cwd?: string; command?: string[]; status?: string; exit_code?: number };
  };
};

function readTranscriptTail(path: string): string[] {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const file = fstatSync(fd);
    if (!file.isFile()) return [];
    const start = Math.max(0, file.size - MAX_TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(file.size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8", 0, bytesRead).split("\n");
    return start === 0 ? lines : lines.slice(1);
  } finally {
    closeSync(fd);
  }
}

function parseCompletion(line: string): CommandCompletion | null {
  try { return JSON.parse(line) as CommandCompletion; }
  catch { return null; }
}

/** Hydrate Codex Bash's text-only result from the native completion for the same tool call. */
export function withCodexCommandResult(input: HookInput, codexHome: string): HookInput {
  if (input.session_host !== "codex" || input.hook_event_name !== "PostToolUse" || input.tool_name !== "Bash"
    || typeof input.tool_response !== "string") return input;

  const command = nestedText(input.tool_input, ["command"]);
  const { session_id: session, turn_id: turn, tool_use_id: tool, cwd, transcript_path: transcript } = input;
  if (!command || !isHookVerificationCommand(command) || typeof session !== "string" || !session
    || typeof turn !== "string" || !turn || typeof tool !== "string" || !tool
    || typeof cwd !== "string" || !isAbsolute(cwd) || typeof transcript !== "string" || !isAbsolute(transcript)
    || !basename(transcript).endsWith(`-${session}.jsonl`)) return input;

  try {
    const sessions = realpathSync(join(codexHome, "sessions"));
    const path = relative(sessions, realpathSync(transcript));
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) return input;
    const directory = pathToFileURL(realpathSync(cwd)).href;
    const lines = readTranscriptTail(transcript);

    for (const line of lines.reverse()) {
      if (!line.includes(tool)) continue;
      const record = parseCompletion(line);
      const event = record?.payload;
      if (record?.type !== "event_msg" || event?.type !== "item_completed"
        || event.thread_id !== session || event.turn_id !== turn) continue;
      const item = event.item;
      if (item?.type !== "CommandExecution" || item.id !== tool || item.cwd !== directory
        || !Array.isArray(item.command) || item.command.at(-1) !== command) continue;
      const exit = item.exit_code;
      if (typeof exit !== "number" || !Number.isSafeInteger(exit) || exit < 0
        || item.status !== (exit === 0 ? "completed" : "failed")) return input;
      const completed = { ...input, tool_response: { exit_code: exit } };
      verifiedCodexCompletions.add(completed);
      return completed;
    }
  } catch { /* Unavailable or incompatible Host evidence leaves verification unknown. */ }
  return input;
}

/** Claude's successful/failed events are native terminal receipts; Bash exposes no numeric exit code. */
export function withClaudeCommandResult(input: HookInput, claudeHome: string): HookInput {
  if (input.session_host !== "claude" || !["PostToolUse", "PostToolUseFailure"].includes(String(input.hook_event_name))
    || input.tool_name !== "Bash") return input;
  const command = nestedText(input.tool_input, ["command"]);
  const { session_id: session, prompt_id: prompt, tool_use_id: tool, cwd, transcript_path: transcript } = input;
  if (!command || !isHookVerificationCommand(command) || typeof session !== "string" || !session
    || typeof prompt !== "string" || !prompt || typeof tool !== "string" || !tool
    || typeof cwd !== "string" || !isAbsolute(cwd) || typeof transcript !== "string" || !isAbsolute(transcript)
    || basename(transcript) !== session + ".jsonl") return input;
  const failed = input.hook_event_name === "PostToolUseFailure";
  const response = input.tool_response as Record<string, unknown> | undefined;
  if (failed ? typeof input.error !== "string" || !input.error || input.is_interrupt !== false || response !== undefined
    : input.error !== undefined || !response || response.interrupted !== false || typeof response.stdout !== "string"
      || typeof response.stderr !== "string" || response.backgroundTaskId !== undefined
      || response.exit_code !== undefined || response.exitCode !== undefined || response.status !== undefined
      || response.is_error === true || response.success === false || response.error !== undefined || response.timed_out === true) return input;
  try {
    const projects = realpathSync(join(claudeHome, "projects"));
    const path = relative(projects, realpathSync(transcript));
    if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) return input;
    realpathSync(cwd);
    return { ...input, hook_event_name: "PostToolUse", tool_response: { status: failed ? "failed" : "passed" } };
  } catch { /* Missing or incompatible Host identity leaves verification unknown. */ }
  return input;
}

type NativeRecord = {
  type?: string; timestamp?: string; sessionId?: string; promptId?: string; cwd?: string; uuid?: string;
  sourceToolAssistantUUID?: string;
  origin?: { kind?: string; producer?: string }; promptSource?: string; turnOrigin?: string;
  toolUseResult?: { backgroundTaskId?: string; interrupted?: boolean };
  attachment?: { type?: string; commandMode?: string; origin?: { kind?: string; producer?: string }; prompt?: string };
  message?: { content?: Array<{ type?: string; id?: string; tool_use_id?: string; name?: string; input?: { command?: string } }> };
  payload?: { type?: string; thread_id?: string; turn_id?: string; item?: {
    type?: string; id?: string; cwd?: string; command?: string[]; status?: string; exit_code?: number; process_id?: string;
    duration?: { secs?: number; nanos?: number };
  } };
};
function nativeRecord(line: string): NativeRecord | null {
  try { return JSON.parse(line) as NativeRecord; } catch { return null; }
}

function nativeTaskNotification(record: NativeRecord | null): string | null {
  const attachment = record?.attachment;
  if (record?.type === "attachment" && attachment?.type === "queued_command" && attachment.commandMode === "task-notification"
    && attachment.origin?.kind === "task-notification" && attachment.origin.producer === "session-task")
    return typeof attachment.prompt === "string" ? attachment.prompt : null;
  if (record?.type === "user" && record.origin?.kind === "task-notification" && record.origin.producer === "session-task"
    && record.promptSource === "system" && record.turnOrigin === "task_notification") {
    const content = (record.message as { content?: unknown } | undefined)?.content;
    return typeof content === "string" ? content : null;
  }
  return null;
}

/** Reconcile background terminal facts before Stop; task output text never establishes success. */
export function nativeAsyncVerificationResults(input: HookInput, hostHome: string): HookInput[] {
  if (input.hook_event_name !== "Stop" || input.session_host !== "claude") return [];
  const { session_id: session, cwd, transcript_path: transcript } = input;
  if (typeof session !== "string" || !session || typeof cwd !== "string" || !isAbsolute(cwd)
    || typeof transcript !== "string" || !isAbsolute(transcript)) return [];
  if (basename(transcript) !== session + ".jsonl") return [];
  try {
    const root = realpathSync(join(hostHome, "projects"));
    const relativePath = relative(root, realpathSync(transcript));
    if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) return [];
    const directory = realpathSync(cwd);
    const records = readTranscriptTail(transcript).map(nativeRecord);
    if (typeof input.prompt_id !== "string" || !input.prompt_id) return [];
    const scoped = records.filter(record => record?.sessionId === session && record.cwd === directory);
    const turn = scoped;
    const edits = turn.flatMap((record, index) => record?.type === "assistant" && Array.isArray(record.message?.content)
      && record.message.content.some(item => item.type === "tool_use" && (["Edit", "Write", "apply_patch"].includes(String(item.name))
        || item.name === "Bash" && /(?:apply_patch|git\s+apply|sed\s+-i|perl\s+-pi)\b/u.test(item.input?.command ?? ""))) ? [index] : []);
    return turn.flatMap((record, index) => {
      const background = record?.toolUseResult;
      if (record?.type !== "user" || typeof record.promptId !== "string" || !record.promptId || background?.interrupted !== false
        || typeof background.backgroundTaskId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(background.backgroundTaskId) || !Array.isArray(record.message?.content)) return [];
      const origin = turn.findIndex(item => item?.type === "assistant" && item.uuid === record.sourceToolAssistantUUID);
      const boundary = turn.findIndex(item => item?.type === "user" && item.promptId === record.promptId && !item.sourceToolAssistantUUID);
      if (origin < 0 || boundary < 0 || origin <= boundary) return [];
      const tool = record.message.content.find(item => item.type === "tool_result");
      const call = turn[origin]!.message?.content?.find(item => item.type === "tool_use" && item.id === tool?.tool_use_id && item.name === "Bash");
      if (!call?.id || !call.input?.command || !isHookVerificationCommand(call.input.command)) return [];
      const completedIndex = turn.findIndex((item, completionIndex) => {
        if (completionIndex <= index) return false;
        const prompt = nativeTaskNotification(item);
        return prompt !== null && prompt.includes(`<task-id>${background.backgroundTaskId}</task-id>`)
          && prompt.includes(`<tool-use-id>${call.id}</tool-use-id>`);
      });
      if (completedIndex < 0 || edits.some(edit => edit > origin && edit < completedIndex)) return [];
      const status = nativeTaskNotification(turn[completedIndex]!)?.match(/<status>(completed|failed)<\/status>/u)?.[1];
      return status ? [{ ...input, [NATIVE_ASYNC_COMPLETION]: true, prompt_id: record.promptId, turn_id: record.promptId, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: call.id,
        tool_input: { command: call.input.command }, tool_response: { status: status === "completed" ? "passed" : "failed" } }] : [];
    });
  } catch { return []; }
}
