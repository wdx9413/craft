import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeHostProcess, type HostExecutor } from "../../core/host-driver.ts";
import type { JsonObject } from "../../core/infrastructure/store.ts";
import type { ChatRequest, ChatResult, ModelProviderSpec, ModelTransport } from "../../core/model-gateway.ts";
import { createFetchTransport } from "../../core/model-gateway.ts";
import { estimateTokens } from "../../core/token-budget.ts";

const MODEL = "gpt-6-luna";
const TIMEOUT_MS = 120_000;
const OUTPUT_LIMIT = 65_536;
const OUTPUT_SCHEMA_LIMIT = 16_384;
export const DEFAULT_LEARNING_INPUT_TOKEN_LIMIT = 8_192;

function outputSchemaFrom(request: ChatRequest): JsonObject | null {
  const value = request.body.codex_output_schema;
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value) || (value as JsonObject).type !== "object") {
    throw new Error("Codex Host output schema must be an object schema");
  }
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > OUTPUT_SCHEMA_LIMIT) throw new Error("Codex Host output schema exceeds its bound");
  return value as JsonObject;
}

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
    failed: events.some(event => event.type === "turn.failed" || event.type === "error"
      || typeof event.type === "string" && event.type.startsWith("item.")
        && !["agent_message", "reasoning"].includes(String((event.item as JsonObject | undefined)?.type))
        // CLI 0.163 emits this intentional catalog omission as an error item.
        // Only this exact notice is non-fatal; unknown settings and tool events fail.
        && !(event.type === "item.completed" && (event.item as JsonObject | undefined)?.type === "error"
          && /^Exceeded skills context budget\. All skill descriptions were removed and [0-9]{1,6} additional skills were not included in the model-visible skills list\.$/u
            .test(String((event.item as JsonObject).message)))) };
}

/** Isolated Codex CLI transport for bounded evaluation tickets; one model call per worker tick. */
export class CodexCliModelTransport implements ModelTransport {
  readonly executor: HostExecutor;
  readonly maxInputTokens: number;
  private used = false;

  constructor(executor: HostExecutor = executeHostProcess, options: { max_input_tokens?: number } = {}) {
    this.executor = executor;
    this.maxInputTokens = options.max_input_tokens ?? DEFAULT_LEARNING_INPUT_TOKEN_LIMIT;
    if (!Number.isSafeInteger(this.maxInputTokens) || this.maxInputTokens < 1 || this.maxInputTokens > 32_768) throw new Error("max_input_tokens must be between 1 and 32768");
  }

  acquireCall(provider: string): boolean {
    if (provider !== "codex-cli" || this.used) return false;
    this.used = true;
    return true;
  }

  async complete(spec: ModelProviderSpec, request: ChatRequest): Promise<ChatResult> {
    if (spec.provider !== "codex-cli" || !spec.host_managed_auth) throw new Error("Codex Host transport received an incompatible provider");
    if (request.body.model !== MODEL) throw new Error(`Codex Host model must be ${MODEL}`);
    const prompt = messagesFrom(request).map(message => `## ${message.role}\n${message.content}`).join("\n\n");
    if (estimateTokens(prompt) > this.maxInputTokens) throw Object.assign(new Error("Codex Host business input exceeds its estimated token budget"), { code: "ERR_CODEX_INPUT_BUDGET_EXCEEDED" });
    const schema = outputSchemaFrom(request);
    let schemaDirectory: string | null = null;
    try {
      const argv = ["exec", "--ignore-user-config", "--ephemeral", "--sandbox", "read-only", "--skip-git-repo-check"];
      // These tasks receive their complete evidence packet and do not use tools
      // or an available-skills catalog. Keep the Host's safety rules intact.
      argv.push("-c", "skills.max_context_tokens=1", "-c", "features.shell_tool=false", "-c", "features.view_image=false", "-c", 'web_search="disabled"');
      if (schema) {
        schemaDirectory = await mkdtemp(join(tmpdir(), "craft-learning-schema-"));
        const schemaPath = join(schemaDirectory, "output-schema.json");
        await writeFile(schemaPath, JSON.stringify(schema), { encoding: "utf8", flag: "wx", mode: 0o600 });
        argv.push("--output-schema", schemaPath);
      }
      argv.push("--model", MODEL, "--json", "-");
      const result = await this.executor({ executable: "codex", argv, cwd: tmpdir(), stdin: prompt, timeoutMs: TIMEOUT_MS, outputLimit: OUTPUT_LIMIT });
      const parsed = parseEvents(result.stdout);
      const completed = result.exitCode === 0 && result.signal === null && !result.timedOut && !result.cancelled && !result.outputLimited
        && !parsed.invalid && !parsed.failed && parsed.terminal !== null && parsed.terminalLast && parsed.message !== null;
      if (!completed) throw Object.assign(new Error(result.timedOut ? "Codex Host timed out" : result.outputLimited ? "Codex Host output exceeded its bound" : "Codex Host did not return one complete model response"),
        { code: result.timedOut ? "ERR_CODEX_HOST_TIMEOUT" : result.outputLimited ? "ERR_CODEX_OUTPUT_BUDGET_EXCEEDED" : "ERR_CODEX_HOST_RESPONSE_INVALID" });
      const usage = parsed.usage;
      return { text: parsed.message!, model: MODEL, usage: usage && Number.isSafeInteger(usage.input_tokens) && Number.isSafeInteger(usage.output_tokens)
        ? { input_tokens: Number(usage.input_tokens), output_tokens: Number(usage.output_tokens) } : null };
    } finally {
      if (schemaDirectory) await rm(schemaDirectory, { recursive: true, force: true });
    }
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
