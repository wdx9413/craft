import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AutonomyKernel } from "./autonomy.js";
import { executeCodex } from "./codex-driver.js";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function integer(value, name, fallback, minimum, maximum) { const result = value === undefined ? fallback : Number(value); if (!Number.isInteger(result) || result < minimum || result > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return result; }
function optionalMoney(value) { if (value === undefined)
    return null; const result = Number(value); if (!Number.isFinite(result) || result <= 0 || result > 1_000)
    throw new Error("max_budget_usd must be between 0 and 1000"); return result; }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function redact(value) { return value.replace(/(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]+/giu, "[redacted]"); }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
function parse(stdout) {
    const events = [];
    let invalidLines = 0;
    for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
        try {
            const event = JSON.parse(line);
            if (!event || typeof event !== "object" || Array.isArray(event))
                invalidLines += 1;
            else
                events.push(event);
        }
        catch {
            invalidLines += 1;
        }
    }
    const init = events.find((event) => event.type === "system" && event.subtype === "init");
    const result = [...events].reverse().find((event) => event.type === "result");
    const assistants = events.filter((event) => event.type === "assistant").flatMap((event) => { const content = event.message?.content; return Array.isArray(content) ? content : []; }).filter((item) => Boolean(item) && typeof item === "object" && !Array.isArray(item) && item.type === "text" && typeof item.text === "string");
    const final = typeof result?.result === "string" ? result.result : assistants.length ? assistants.map((item) => item.text).join("\n") : null;
    return { events, invalidLines, sessionId: typeof init?.session_id === "string" ? init.session_id : typeof result?.session_id === "string" ? result.session_id : null,
        finalMessage: final === null ? null : redact(String(final)), usage: result?.usage && typeof result.usage === "object" && !Array.isArray(result.usage) ? result.usage : null,
        costUsd: typeof result?.total_cost_usd === "number" && Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null,
        resultSubtype: typeof result?.subtype === "string" ? result.subtype : null };
}
export class ClaudeHostKernel {
    host = "claude-code";
    store;
    executor;
    constructor(store, executor = executeCodex) { this.store = store; this.executor = executor; }
    prepare(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const prompt = text(args.prompt, "prompt");
        const workspace = resolve(text(args.workspace, "workspace"));
        const sandbox = String(args.sandbox ?? "read-only");
        if (!new Set(["read-only", "workspace-write"]).has(sandbox))
            throw new Error("Claude sandbox is unsupported");
        const model = args.model === undefined ? null : text(args.model, "model");
        const maxTurns = integer(args.max_turns, "max_turns", 12, 1, 100);
        const maxBudgetUsd = optionalMoney(args.max_budget_usd);
        const dispatchId = String(args.dispatch_id ?? `claude_dispatch_${randomUUID().replaceAll("-", "")}`);
        const identity = { task_id: task.id, task_version: task.version, workspace, sandbox, model, max_turns: maxTurns, max_budget_usd: maxBudgetUsd, prompt_digest: digest(prompt) };
        const requestDigest = digest(identity);
        const existing = this.store.find("claude_dispatch", dispatchId);
        if (existing) {
            if (existing.request_digest !== requestDigest)
                throw new Error("Claude dispatch idempotency conflict");
            return { dispatch: existing, idempotent: true };
        }
        return { dispatch: this.store.create("claude_dispatch", dispatchId, { ...identity, request_digest: requestDigest, action: sandbox === "read-only" ? "read" : "sandbox_write", status: "prepared", timeout_ms: integer(args.timeout_ms, "timeout_ms", 900_000, 1_000, 3_600_000), output_limit: integer(args.output_limit, "output_limit", 1_048_576, 4_096, 16_777_216) }), idempotent: false };
    }
    async execute(args, options = {}) {
        const dispatch = this.store.get("claude_dispatch", text(args.dispatch_id, "dispatch_id"));
        const prompt = text(args.prompt, "prompt");
        if (dispatch.status === "completed" || dispatch.status === "failed")
            return { dispatch, receipt: this.store.get("claude_receipt", `receipt_${dispatch.id}`), idempotent: true };
        if (dispatch.status !== "prepared")
            throw new Error("Claude dispatch is not executable");
        if (digest(prompt) !== dispatch.prompt_digest)
            throw new Error("Claude prompt does not match the prepared digest");
        let consumption = null;
        if (dispatch.sandbox === "workspace-write") {
            const plan = new AutonomyKernel(this.store).consumptionPlan({ request_id: args.authorization_request_id, task_id: dispatch.task_id, action: "sandbox_write", target: dispatch.workspace, request_digest: dispatch.request_digest, idempotency_key: `claude:${dispatch.id}`, notification_ref: args.notification_ref, now: args.now });
            if (plan.existing)
                throw new Error("Claude authorization was already consumed");
            [consumption] = this.store.saveBatch(plan.entries);
        }
        const tools = dispatch.sandbox === "read-only" ? "Read,Glob,Grep" : "Read,Glob,Grep,Edit,Write";
        const permission = dispatch.sandbox === "read-only" ? "plan" : "acceptEdits";
        const argv = ["-p", "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--permission-mode", permission, "--permission-prompts", "none", "--tools", tools, "--disallowedTools", "mcp__*", "--max-turns", String(dispatch.max_turns)];
        if (dispatch.max_budget_usd !== null)
            argv.push("--max-budget-usd", String(dispatch.max_budget_usd));
        if (dispatch.model)
            argv.push("--model", String(dispatch.model));
        this.store.save("claude_dispatch", String(dispatch.id), { ...payload(dispatch), status: "running", started_at: new Date().toISOString(), authorization_consumption_id: consumption?.id ?? null });
        let execution;
        try {
            execution = await this.executor({ executable: "claude", argv, cwd: String(dispatch.workspace), stdin: prompt, timeoutMs: Number(dispatch.timeout_ms), outputLimit: Number(dispatch.output_limit), signal: options.signal, observe: options.observe });
        }
        catch (error) {
            execution = { exitCode: null, signal: null, stdout: "", stderr: error instanceof Error ? error.message : "Claude process failed", timedOut: false, cancelled: options.signal?.aborted ?? false, outputLimited: false };
        }
        const parsed = parse(execution.stdout);
        const status = execution.exitCode === 0 && !execution.timedOut && parsed.invalidLines === 0 && parsed.resultSubtype !== "error" ? "completed" : "failed";
        const receiptPayload = { dispatch_id: dispatch.id, task_id: dispatch.task_id, host: this.host, sandbox: dispatch.sandbox, status, exit_code: execution.exitCode, signal: execution.signal, timed_out: execution.timedOut, cancelled: execution.cancelled ?? false, output_limited: execution.outputLimited, invalid_jsonl_lines: parsed.invalidLines, event_count: parsed.events.length, event_types: [...new Set(parsed.events.map((event) => String(event.type)))], session_id: parsed.sessionId, final_message: parsed.finalMessage, usage: parsed.usage, cost_usd: parsed.costUsd, result_subtype: parsed.resultSubtype, stderr_digest: digest(execution.stderr), completed_at: new Date().toISOString() };
        const directory = join(this.store.paths.artifactsDir, "claude");
        await mkdir(directory, { recursive: true });
        const receiptPath = join(directory, `${dispatch.id}.json`);
        await writeFile(receiptPath, `${JSON.stringify(receiptPayload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        const receipt = this.store.create("claude_receipt", `receipt_${dispatch.id}`, { ...receiptPayload, uri: pathToFileURL(receiptPath).toString(), digest: digest(receiptPayload) });
        const saved = this.store.save("claude_dispatch", String(dispatch.id), { ...payload(dispatch), status, receipt_id: receipt.id, finished_at: receiptPayload.completed_at });
        this.store.appendEvent(`task:${dispatch.task_id}`, "host.claude.completed", { dispatch_id: dispatch.id, receipt_id: receipt.id, status });
        return { dispatch: saved, receipt, idempotent: false };
    }
}
//# sourceMappingURL=claude-driver.js.map