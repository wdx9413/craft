import { tmpdir } from "node:os";
import { executeHostProcess, type HostExecutor } from "../../core/host-driver.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";
import type { ChatRequest, ChatResult, ModelProviderSpec, ModelTransport } from "../../core/model-gateway.ts";
import { createFetchTransport } from "../../core/model-gateway.ts";

const MODEL = "gpt-6-luna";
const TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 65_536;

function messagesFrom(request: ChatRequest): Array<{ role: string; content: string }> {
  const messages = request.body.messages;
  if (!Array.isArray(messages) || !messages.length) throw new Error("Codex Host request must contain messages");
  return messages.map((value, index) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Codex Host message ${index} must be an object`);
    const item = value as JsonObject;
    if (typeof item.role !== "string" || typeof item.content !== "string") throw new Error(`Codex Host message ${index} must contain text`);
    if (!(new Set(["system", "user", "assistant"])).has(item.role)) throw new Error(`Codex Host role ${item.role} is unsupported`);
    return { role: item.role, content: item.content };
  });
}

function parseEvents(stdout: string): { invalid: boolean; message: string | null; usage: JsonObject | null; terminal: JsonObject | null; terminalLast: boolean; failed: boolean } {
  const events: JsonObject[] = [];
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
    try {
      const value: unknown = JSON.parse(line);
      if (!value || typeof value !== "object" || Array.isArray(value)) return { invalid: true, message: null, usage: null, terminal: null, terminalLast: false, failed: false };
      events.push(value as JsonObject);
    } catch { return { invalid: true, message: null, usage: null, terminal: null, terminalLast: false, failed: false }; }
  }
  const messages = events.filter(event => event.type === "item.completed" && (event.item as JsonObject | undefined)?.type === "agent_message");
  const terminalEvents = events.filter(event => event.type === "turn.completed");
  const terminal = terminalEvents.length === 1 ? terminalEvents[0]! : null;
  const usage = terminal?.usage && typeof terminal.usage === "object" && !Array.isArray(terminal.usage) ? terminal.usage as JsonObject : null;
  const message = messages.at(-1)?.item as JsonObject | undefined;
  return { invalid: false, message: typeof message?.text === "string" ? message.text : null, usage, terminal, terminalLast: events.at(-1) === terminal,
    failed: events.some(event => event.type === "turn.failed" || event.type === "error") };
}

/** Isolated Codex CLI transport for bounded evaluation tickets; one model call per worker tick. */
export class CodexCliModelTransport implements ModelTransport {
  readonly executor: HostExecutor;
  private used = false;

  constructor(executor: HostExecutor = executeHostProcess) { this.executor = executor; }

  acquireCall(provider: string): boolean {
    if (provider !== "codex-cli" || this.used) return false;
    this.used = true;
    return true;
  }

  async complete(spec: ModelProviderSpec, request: ChatRequest): Promise<ChatResult> {
    if (spec.provider !== "codex-cli" || !spec.host_managed_auth) throw new Error("Codex Host transport received an incompatible provider");
    if (request.body.model !== MODEL) throw new Error(`Codex Host model must be ${MODEL}`);
    const prompt = messagesFrom(request).map(message => `## ${message.role}\n${message.content}`).join("\n\n");
    const argv = ["exec", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check", "--model", MODEL, "--json", "-"];
    const result = await this.executor({ executable: "codex", argv, cwd: tmpdir(), stdin: prompt, timeoutMs: TIMEOUT_MS, outputLimit: OUTPUT_LIMIT });
    const parsed = parseEvents(result.stdout);
    const completed = result.exitCode === 0 && result.signal === null && !result.timedOut && !result.cancelled && !result.outputLimited
      && !parsed.invalid && !parsed.failed && parsed.terminal !== null && parsed.terminalLast && parsed.message !== null;
    if (!completed) throw new Error(result.timedOut ? "Codex Host timed out" : result.outputLimited ? "Codex Host output exceeded its bound" : "Codex Host did not return one complete model response");
    const usage = parsed.usage;
    return { text: parsed.message!, model: MODEL, usage: usage && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens)
      ? { input_tokens: Number(usage.input_tokens), output_tokens: Number(usage.output_tokens) } : null };
  }
}

/** Route only the Codex Host profile to CLI; configured API profiles keep the standard gateway. */
export function createLearningModelTransport(host: string | undefined, executor?: HostExecutor): ModelTransport | undefined {
  if (host !== "codex-cli") return undefined;
  const codex = new CodexCliModelTransport(executor);
  const api = createFetchTransport({ maxAttempts: 1 });
  let used = false;
  return {
    acquireCall: provider => {
      if (used) return false;
      if (provider === "codex-cli") codex.acquireCall(provider);
      used = true;
      return true;
    },
    complete: (spec, request) => spec.provider === "codex-cli" ? codex.complete(spec, request) : api.complete(spec, request),
  };
}
