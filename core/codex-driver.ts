import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AutonomyKernel } from "./autonomy.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { executeHostProcess, type HostDriver, type HostExecutionRequest, type HostExecutionResult, type HostExecutor, type HostOutputObserver, type HostSandbox } from "./host-driver.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";

export type CodexSandbox = HostSandbox;
export type CodexExecutionRequest = HostExecutionRequest;
export type CodexExecutionResult = HostExecutionResult;
export type CodexExecutor = HostExecutor;


function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number { const result = value === undefined ? fallback : Number(value); if (!Number.isInteger(result) || result < minimum || result > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return result; }

function redact(value: string): string { return value.replace(/(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]+/giu, "[redacted]"); }


// The bounded child-process runner lives in host-driver.ts so every host driver
// shares one sandbox/output-limit/cancellation implementation. `executeCodex`
// stays exported because it is the injectable seam the Codex tests replace.
export const executeCodex: CodexExecutor = executeHostProcess;

function parseEvents(stdout: string): { events: JsonObject[]; invalidLines: number; threadId: string | null; finalMessage: string | null; usage: JsonObject | null } {
  const events: JsonObject[] = []; let invalidLines = 0;
  for (const line of stdout.split(/\r?\n/u).filter(Boolean)) { try { const value = JSON.parse(line); if (!value || typeof value !== "object" || Array.isArray(value)) invalidLines += 1; else events.push(value as JsonObject); } catch { invalidLines += 1; } }
  const started = events.find((event) => event.type === "thread.started");
  const messages = events.filter((event) => event.type === "item.completed" && (event.item as JsonObject | undefined)?.type === "agent_message");
  const completed = [...events].reverse().find((event) => event.type === "turn.completed");
  return { events, invalidLines, threadId: typeof started?.thread_id === "string" ? started.thread_id : null,
    finalMessage: typeof (messages.at(-1)?.item as JsonObject | undefined)?.text === "string" ? redact(String((messages.at(-1)!.item as JsonObject).text)) : null,
    usage: completed?.usage && typeof completed.usage === "object" && !Array.isArray(completed.usage) ? completed.usage as JsonObject : null };
}

export class CodexHostKernel implements HostDriver {
  readonly host = "codex-cli";
  readonly dispatchKind = "codex_dispatch";
  readonly store: CraftStore; executor: CodexExecutor;
  constructor(store: CraftStore, executor: CodexExecutor = executeCodex) { this.store = store; this.executor = executor; }

  prepare(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id")); const prompt = text(args.prompt, "prompt");
    const workspace = resolve(text(args.workspace, "workspace"));
    const sandbox = String(args.sandbox ?? "read-only") as CodexSandbox; if (!new Set(["read-only", "workspace-write"]).has(sandbox)) throw new Error("Codex sandbox is unsupported");
    const model = args.model === undefined ? null : text(args.model, "model");
    const evaluationMode = args.evaluation_mode === undefined ? false : args.evaluation_mode === true ? true : args.evaluation_mode === false ? false : (() => { throw new Error("evaluation_mode must be a boolean"); })();
    const dispatchId = String(args.dispatch_id ?? `codex_dispatch_${randomUUID().replaceAll("-", "")}`);
    const identity = { task_id: task.id, task_version: task.version, workspace, sandbox, model, evaluation_mode: evaluationMode, prompt_digest: digestJson(prompt) }; const requestDigest = digestJson(identity);
    const existing = this.store.find("codex_dispatch", dispatchId); if (existing) { if (existing.request_digest !== requestDigest) throw new Error("Codex dispatch idempotency conflict"); return { dispatch: existing, idempotent: true }; }
    return { dispatch: this.store.create("codex_dispatch", dispatchId, { ...identity, request_digest: requestDigest, action: sandbox === "read-only" ? "read" : "sandbox_write", status: "prepared", timeout_ms: integer(args.timeout_ms, "timeout_ms", 900_000, 1_000, 3_600_000), output_limit: integer(args.output_limit, "output_limit", 1_048_576, 4_096, 16_777_216) }), idempotent: false };
  }

  async execute(args: JsonObject, options: { signal?: AbortSignal; observe?: HostOutputObserver } = {}): Promise<JsonObject> {
    const dispatch = this.store.get("codex_dispatch", text(args.dispatch_id, "dispatch_id")); const prompt = text(args.prompt, "prompt");
    if (dispatch.status === "completed" || dispatch.status === "failed") return { dispatch, receipt: this.store.get("codex_receipt", `receipt_${dispatch.id}`), idempotent: true };
    if (dispatch.status !== "prepared") throw new Error("Codex dispatch is not executable"); if (digestJson(prompt) !== dispatch.prompt_digest) throw new Error("Codex prompt does not match the prepared digest");
    let consumption: JsonObject | null = null;
    if (dispatch.sandbox === "workspace-write") { const plan = new AutonomyKernel(this.store).consumptionPlan({ request_id: args.authorization_request_id, task_id: dispatch.task_id, action: "sandbox_write", target: dispatch.workspace, request_digest: dispatch.request_digest, idempotency_key: `codex:${dispatch.id}`, notification_ref: args.notification_ref, now: args.now }); if (plan.existing) throw new Error("Codex authorization was already consumed"); [consumption] = this.store.saveBatch(plan.entries); }
    const argv = ["exec", "--json", "--ephemeral", "--sandbox", String(dispatch.sandbox), "--cd", String(dispatch.workspace)]; if (dispatch.model) argv.push("--model", String(dispatch.model)); if (dispatch.evaluation_mode === true) argv.push("--ignore-user-config", "--ignore-rules"); argv.push("-");
    this.store.save("codex_dispatch", String(dispatch.id), { ...payload(dispatch), status: "running", started_at: new Date().toISOString(), authorization_consumption_id: consumption?.id ?? null });
    let result: CodexExecutionResult;
    try { result = await this.executor({ executable: "codex", argv, cwd: String(dispatch.workspace), stdin: prompt, timeoutMs: Number(dispatch.timeout_ms), outputLimit: Number(dispatch.output_limit), signal: options.signal, observe: options.observe }); }
    catch (error) { result = { exitCode: null, signal: null, stdout: "", stderr: error instanceof Error ? error.message : "Codex process failed", timedOut: false, cancelled: options.signal?.aborted ?? false, outputLimited: false }; }
    const parsed = parseEvents(result.stdout); const status = result.exitCode === 0 && !result.timedOut && parsed.invalidLines === 0 ? "completed" : "failed";
    const receiptPayload = { dispatch_id: dispatch.id, task_id: dispatch.task_id, host: "codex-cli", sandbox: dispatch.sandbox, model: dispatch.model, model_fingerprint: digestJson({ model: dispatch.model }), evaluation_mode: dispatch.evaluation_mode === true, status, exit_code: result.exitCode, signal: result.signal, timed_out: result.timedOut, cancelled: result.cancelled ?? false, output_limited: result.outputLimited, invalid_jsonl_lines: parsed.invalidLines, event_count: parsed.events.length, event_types: [...new Set(parsed.events.map((event) => String(event.type)))], thread_id: parsed.threadId, final_message: parsed.finalMessage, usage: parsed.usage, stderr_digest: digestJson(result.stderr), completed_at: new Date().toISOString() };
    const directory = join(this.store.paths.artifactsDir, "codex"); await mkdir(directory, { recursive: true }); const receiptPath = join(directory, `${dispatch.id}.json`); await writeFile(receiptPath, `${JSON.stringify(receiptPayload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const receipt = this.store.create("codex_receipt", `receipt_${dispatch.id}`, { ...receiptPayload, uri: pathToFileURL(receiptPath).toString(), digest: digestJson(receiptPayload) });
    const saved = this.store.save("codex_dispatch", String(dispatch.id), { ...payload(dispatch), status, receipt_id: receipt.id, finished_at: receiptPayload.completed_at });
    this.store.appendEvent(`task:${dispatch.task_id}`, "host.codex.completed", { dispatch_id: dispatch.id, receipt_id: receipt.id, status });
    return { dispatch: saved, receipt, idempotent: false };
  }
}
