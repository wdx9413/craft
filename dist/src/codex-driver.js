import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AutonomyKernel } from "./autonomy.js";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function integer(value, name, fallback, minimum, maximum) { const result = value === undefined ? fallback : Number(value); if (!Number.isInteger(result) || result < minimum || result > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return result; }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function redact(value) { return value.replace(/(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]+/giu, "[redacted]"); }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
export const executeCodex = async (request) => new Promise((accept, reject) => {
    const child = spawn(request.executable, request.argv, { cwd: request.cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let outputLimited = false;
    let timedOut = false;
    let cancelled = false;
    const append = (current, chunk) => { const next = current + chunk.toString("utf8"); if (Buffer.byteLength(next) <= request.outputLimit)
        return next; outputLimited = true; return Buffer.from(next).subarray(0, request.outputLimit).toString("utf8"); };
    const observed = (stream, chunk) => request.observe?.({ stream, bytes: chunk.length, digest: digest(chunk.toString("utf8")) });
    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); observed("stdout", chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); observed("stderr", chunk); });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, request.timeoutMs);
    const abort = () => { cancelled = true; child.kill(); };
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.signal?.aborted)
        abort();
    child.once("close", (exitCode, signal) => { clearTimeout(timer); request.signal?.removeEventListener("abort", abort); accept({ exitCode, signal, stdout, stderr, timedOut, cancelled, outputLimited }); });
    child.stdin.end(request.stdin);
});
function parseEvents(stdout) {
    const events = [];
    let invalidLines = 0;
    for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
        try {
            const value = JSON.parse(line);
            if (!value || typeof value !== "object" || Array.isArray(value))
                invalidLines += 1;
            else
                events.push(value);
        }
        catch {
            invalidLines += 1;
        }
    }
    const started = events.find((event) => event.type === "thread.started");
    const messages = events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message");
    const completed = [...events].reverse().find((event) => event.type === "turn.completed");
    return { events, invalidLines, threadId: typeof started?.thread_id === "string" ? started.thread_id : null,
        finalMessage: typeof messages.at(-1)?.item?.text === "string" ? redact(String(messages.at(-1).item.text)) : null,
        usage: completed?.usage && typeof completed.usage === "object" && !Array.isArray(completed.usage) ? completed.usage : null };
}
export class CodexHostKernel {
    host = "codex-cli";
    store;
    executor;
    constructor(store, executor = executeCodex) { this.store = store; this.executor = executor; }
    prepare(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const prompt = text(args.prompt, "prompt");
        const workspace = resolve(text(args.workspace, "workspace"));
        const sandbox = String(args.sandbox ?? "read-only");
        if (!new Set(["read-only", "workspace-write"]).has(sandbox))
            throw new Error("Codex sandbox is unsupported");
        const model = args.model === undefined ? null : text(args.model, "model");
        const dispatchId = String(args.dispatch_id ?? `codex_dispatch_${randomUUID().replaceAll("-", "")}`);
        const identity = { task_id: task.id, task_version: task.version, workspace, sandbox, model, prompt_digest: digest(prompt) };
        const requestDigest = digest(identity);
        const existing = this.store.find("codex_dispatch", dispatchId);
        if (existing) {
            if (existing.request_digest !== requestDigest)
                throw new Error("Codex dispatch idempotency conflict");
            return { dispatch: existing, idempotent: true };
        }
        return { dispatch: this.store.create("codex_dispatch", dispatchId, { ...identity, request_digest: requestDigest, action: sandbox === "read-only" ? "read" : "sandbox_write", status: "prepared", timeout_ms: integer(args.timeout_ms, "timeout_ms", 900_000, 1_000, 3_600_000), output_limit: integer(args.output_limit, "output_limit", 1_048_576, 4_096, 16_777_216) }), idempotent: false };
    }
    async execute(args, options = {}) {
        const dispatch = this.store.get("codex_dispatch", text(args.dispatch_id, "dispatch_id"));
        const prompt = text(args.prompt, "prompt");
        if (dispatch.status === "completed" || dispatch.status === "failed")
            return { dispatch, receipt: this.store.get("codex_receipt", `receipt_${dispatch.id}`), idempotent: true };
        if (dispatch.status !== "prepared")
            throw new Error("Codex dispatch is not executable");
        if (digest(prompt) !== dispatch.prompt_digest)
            throw new Error("Codex prompt does not match the prepared digest");
        let consumption = null;
        if (dispatch.sandbox === "workspace-write") {
            const plan = new AutonomyKernel(this.store).consumptionPlan({ request_id: args.authorization_request_id, task_id: dispatch.task_id, action: "sandbox_write", target: dispatch.workspace, request_digest: dispatch.request_digest, idempotency_key: `codex:${dispatch.id}`, notification_ref: args.notification_ref, now: args.now });
            if (plan.existing)
                throw new Error("Codex authorization was already consumed");
            [consumption] = this.store.saveBatch(plan.entries);
        }
        const argv = ["exec", "--json", "--ephemeral", "--sandbox", String(dispatch.sandbox), "--cd", String(dispatch.workspace)];
        if (dispatch.model)
            argv.push("--model", String(dispatch.model));
        argv.push("-");
        this.store.save("codex_dispatch", String(dispatch.id), { ...payload(dispatch), status: "running", started_at: new Date().toISOString(), authorization_consumption_id: consumption?.id ?? null });
        let result;
        try {
            result = await this.executor({ executable: "codex", argv, cwd: String(dispatch.workspace), stdin: prompt, timeoutMs: Number(dispatch.timeout_ms), outputLimit: Number(dispatch.output_limit), signal: options.signal, observe: options.observe });
        }
        catch (error) {
            result = { exitCode: null, signal: null, stdout: "", stderr: error instanceof Error ? error.message : "Codex process failed", timedOut: false, cancelled: options.signal?.aborted ?? false, outputLimited: false };
        }
        const parsed = parseEvents(result.stdout);
        const status = result.exitCode === 0 && !result.timedOut && parsed.invalidLines === 0 ? "completed" : "failed";
        const receiptPayload = { dispatch_id: dispatch.id, task_id: dispatch.task_id, host: "codex-cli", sandbox: dispatch.sandbox, status, exit_code: result.exitCode, signal: result.signal, timed_out: result.timedOut, cancelled: result.cancelled ?? false, output_limited: result.outputLimited, invalid_jsonl_lines: parsed.invalidLines, event_count: parsed.events.length, event_types: [...new Set(parsed.events.map((event) => String(event.type)))], thread_id: parsed.threadId, final_message: parsed.finalMessage, usage: parsed.usage, stderr_digest: digest(result.stderr), completed_at: new Date().toISOString() };
        const directory = join(this.store.paths.artifactsDir, "codex");
        await mkdir(directory, { recursive: true });
        const receiptPath = join(directory, `${dispatch.id}.json`);
        await writeFile(receiptPath, `${JSON.stringify(receiptPayload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        const receipt = this.store.create("codex_receipt", `receipt_${dispatch.id}`, { ...receiptPayload, uri: pathToFileURL(receiptPath).toString(), digest: digest(receiptPayload) });
        const saved = this.store.save("codex_dispatch", String(dispatch.id), { ...payload(dispatch), status, receipt_id: receipt.id, finished_at: receiptPayload.completed_at });
        this.store.appendEvent(`task:${dispatch.task_id}`, "host.codex.completed", { dispatch_id: dispatch.id, receipt_id: receipt.id, status });
        return { dispatch: saved, receipt, idempotent: false };
    }
}
//# sourceMappingURL=codex-driver.js.map