import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AutonomyKernel } from "./autonomy.js";
import { executeHostProcess } from "./host-driver.js";
import { hostModelFor, renderHostArgv } from "./host-registry.js";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function integer(value, name, fallback, minimum, maximum) { const result = value === undefined ? fallback : Number(value); if (!Number.isInteger(result) || result < minimum || result > maximum)
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`); return result; }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function redact(value) { return value.replace(/(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]+/giu, "[redacted]"); }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
const SANDBOXES = new Set(["read-only", "workspace-write"]);
const MAX_FINAL_MESSAGE_CHARS = 4_000;
/**
 * Runs any user-declared model CLI through one declarative profile.
 *
 * The contract is deliberately narrow: the profile names the executable and an
 * argv template, Craft pipes the prompt on stdin unless the template asks for
 * `{prompt}`, and success is "exit code 0 within the timeout". Anything richer
 * (structured event streams, budget caps, tool allowlists) stays with a built-in
 * driver, because guessing at an unknown CLI's protocol would be worse than
 * refusing to run it.
 */
export class GenericCliHostKernel {
    host;
    dispatchKind;
    profile;
    store;
    executor;
    constructor(store, profile, executor = executeHostProcess) {
        if (profile.builtin)
            throw new Error("Generic CLI hosts require a declared host profile");
        if (profile.kind !== "agent-cli")
            throw new Error("Generic CLI hosts require an agent-cli profile");
        this.store = store;
        this.profile = profile;
        this.host = profile.host;
        this.dispatchKind = profile.dispatch_kind;
        this.executor = executor;
    }
    receiptKind() { return `${this.dispatchKind}_receipt`; }
    prepare(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const prompt = text(args.prompt, "prompt");
        const workspace = resolve(text(args.workspace, "workspace"));
        const sandbox = String(args.sandbox ?? "read-only");
        if (!SANDBOXES.has(sandbox))
            throw new Error("Host sandbox is unsupported");
        const model = hostModelFor(this.profile, args.model);
        const dispatchId = String(args.dispatch_id ?? `${this.dispatchKind}_${randomUUID().replaceAll("-", "")}`);
        const identity = { host: this.host, task_id: task.id, task_version: task.version, workspace, sandbox, model, prompt_digest: digest(prompt) };
        const requestDigest = digest(identity);
        const existing = this.store.find(this.dispatchKind, dispatchId);
        if (existing) {
            if (existing.request_digest !== requestDigest)
                throw new Error("Host dispatch idempotency conflict");
            return { dispatch: existing, idempotent: true };
        }
        return { dispatch: this.store.create(this.dispatchKind, dispatchId, { ...identity, request_digest: requestDigest,
                status: "prepared", action: sandbox === "read-only" ? "read" : "sandbox_write",
                timeout_ms: integer(args.timeout_ms, "timeout_ms", 900_000, 1_000, 3_600_000),
                output_limit: integer(args.output_limit, "output_limit", 1_048_576, 4_096, 16_777_216) }), idempotent: false };
    }
    async execute(args, options = {}) {
        const dispatch = this.store.get(this.dispatchKind, text(args.dispatch_id, "dispatch_id"));
        const prompt = text(args.prompt, "prompt");
        if (digest(prompt) !== dispatch.prompt_digest)
            throw new Error("Host prompt does not match the prepared digest");
        if (dispatch.status === "completed" || dispatch.status === "failed") {
            return { dispatch, receipt: this.store.get(this.receiptKind(), `receipt_${dispatch.id}`), idempotent: true };
        }
        if (dispatch.status !== "prepared")
            throw new Error("Host dispatch is not executable");
        let consumption = null;
        // A declared host writes to the workspace under exactly the same approval
        // gate as a built-in host; plugging in a new model must not widen authority.
        if (dispatch.sandbox === "workspace-write") {
            const plan = new AutonomyKernel(this.store).consumptionPlan({ request_id: args.authorization_request_id, task_id: dispatch.task_id,
                action: "sandbox_write", target: dispatch.workspace, request_digest: dispatch.request_digest,
                idempotency_key: `${this.host}:${dispatch.id}`, notification_ref: args.notification_ref, now: args.now });
            if (plan.existing)
                throw new Error("Host authorization was already consumed");
            [consumption] = this.store.saveBatch(plan.entries);
        }
        const rendered = renderHostArgv(this.profile.argv_template, { prompt, workspace: String(dispatch.workspace),
            model: String(dispatch.model ?? ""), sandbox: String(dispatch.sandbox) });
        this.store.save(this.dispatchKind, String(dispatch.id), { ...payload(dispatch), status: "running",
            started_at: new Date().toISOString(), authorization_consumption_id: consumption?.id ?? null });
        let execution;
        try {
            execution = await this.executor({ executable: this.profile.command, argv: rendered.argv, cwd: String(dispatch.workspace),
                stdin: rendered.prompt_in_argv ? "" : prompt, timeoutMs: Number(dispatch.timeout_ms),
                outputLimit: Number(dispatch.output_limit), signal: options.signal, observe: options.observe });
        }
        catch (error) {
            execution = { exitCode: null, signal: null, stdout: "", stderr: error instanceof Error ? error.message : "Host process failed",
                timedOut: false, cancelled: options.signal?.aborted ?? false, outputLimited: false };
        }
        const status = execution.exitCode === 0 && !execution.timedOut ? "completed" : "failed";
        const trimmed = execution.stdout.trim();
        const receiptPayload = { dispatch_id: dispatch.id, task_id: dispatch.task_id, host: this.host, sandbox: dispatch.sandbox,
            status, exit_code: execution.exitCode, signal: execution.signal, timed_out: execution.timedOut,
            cancelled: execution.cancelled ?? false, output_limited: execution.outputLimited,
            stdout_bytes: Buffer.byteLength(execution.stdout),
            final_message: trimmed ? redact(trimmed).slice(-MAX_FINAL_MESSAGE_CHARS) : null,
            stderr_digest: digest(execution.stderr), completed_at: new Date().toISOString() };
        const directory = join(this.store.paths.artifactsDir, this.host);
        await mkdir(directory, { recursive: true });
        const receiptPath = join(directory, `${dispatch.id}.json`);
        await writeFile(receiptPath, `${JSON.stringify(receiptPayload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        const receipt = this.store.create(this.receiptKind(), `receipt_${dispatch.id}`, { ...receiptPayload,
            uri: pathToFileURL(receiptPath).toString(), digest: digest(receiptPayload) });
        const saved = this.store.save(this.dispatchKind, String(dispatch.id), { ...payload(dispatch), status,
            receipt_id: receipt.id, finished_at: receiptPayload.completed_at });
        this.store.appendEvent(`task:${dispatch.task_id}`, "host.completed", { host: this.host, dispatch_id: dispatch.id,
            receipt_id: receipt.id, status });
        return { dispatch: saved, receipt, idempotent: false };
    }
}
//# sourceMappingURL=generic-driver.js.map