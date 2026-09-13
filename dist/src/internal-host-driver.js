import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { completeLoop, defineLoopLimits, failLoop, beginLoop, loopSummary, observeStep } from "./agent-loop.js";
import { buildChatRequest, credentialStatus, parseChatResponse, selectModel, createFetchTransport } from "./model-gateway.js";
import { compactConversation, createWorkNote, toolResultMessage } from "./runtime-truth.js";
import { TraceKernel } from "./trace-kernel.js";
import { CraftStore } from "./store.js";
function text(value, name) { if (typeof value !== "string" || !value.trim())
    throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value) { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function redact(value) { return value.replace(/(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]+/giu, "[redacted]"); }
function payload(record) { const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...rest } = record; return rest; }
const MAX_FINAL_MESSAGE_CHARS = 4_000;
/**
 * A model reply is only treated as an action when it is a single JSON object with
 * `action` and optional `args`.
 *
 * The cast on the parsed value is deliberate rather than defensive: a text that
 * starts with `{` and ends with `}` can only parse to an object, so an
 * `Array.isArray` / null guard here would be unreachable code that still counts
 * against the coverage gate. Every other shape returns null before this point.
 */
export function parseAction(text) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}"))
        return null;
    let parsed;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        return null;
    }
    const body = parsed;
    if (typeof body.action !== "string" || !body.action.trim())
        return null;
    const args = body.args;
    if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args)))
        return null;
    return { action: body.action.trim(), args: (args ?? {}) };
}
export class InternalHostDriver {
    host = "internal";
    dispatchKind = "internal_dispatch";
    store;
    providers;
    transport;
    invokeAction;
    env;
    tools;
    trace;
    constructor(store, options) {
        if (!options.providers.length)
            throw new Error("The internal host requires at least one declared provider");
        this.store = store;
        this.providers = options.providers;
        this.env = options.env ?? process.env;
        this.tools = options.tools ?? [];
        this.trace = new TraceKernel(store);
        this.transport = options.transport ?? createFetchTransport({ env: this.env });
        this.invokeAction = options.invokeAction;
    }
    receiptKind() { return "internal_receipt"; }
    provider(name) {
        const wanted = typeof name === "string" && name.trim() ? name.trim() : this.providers[0].provider;
        const found = this.providers.find((spec) => spec.provider === wanted);
        if (!found)
            throw new Error(`Unknown model provider: ${wanted}`);
        return found;
    }
    prepare(args) {
        const task = this.store.get("task", text(args.task_id, "task_id"));
        const prompt = text(args.prompt, "prompt");
        const provider = this.provider(args.provider);
        const tier = String(args.tier ?? "standard");
        const selected = selectModel(provider, tier);
        const limits = defineLoopLimits((args.limits ?? {}));
        const dispatchId = String(args.dispatch_id ?? `internal_dispatch_${randomUUID().replaceAll("-", "")}`);
        const identity = { host: this.host, task_id: task.id, task_version: task.version, provider: provider.provider,
            model: selected.model, tier: selected.tier, downgraded: selected.downgraded, limits, prompt_digest: digest(prompt) };
        const requestDigest = digest(identity);
        const existing = this.store.find(this.dispatchKind, dispatchId);
        if (existing) {
            if (existing.request_digest !== requestDigest)
                throw new Error("Internal host dispatch idempotency conflict");
            return { dispatch: existing, idempotent: true, credential: credentialStatus(provider, this.env) };
        }
        return { dispatch: this.store.create(this.dispatchKind, dispatchId, { ...identity, request_digest: requestDigest,
                status: "prepared", effect: "read_only" }), idempotent: false, credential: credentialStatus(provider, this.env) };
    }
    async execute(args, options = {}) {
        let dispatch = this.store.get(this.dispatchKind, text(args.dispatch_id, "dispatch_id"));
        const prompt = text(args.prompt, "prompt");
        if (digest(prompt) !== dispatch.prompt_digest)
            throw new Error("Internal host prompt does not match the prepared digest");
        if (dispatch.status === "completed" || dispatch.status === "failed") {
            return { dispatch, receipt: this.store.get(this.receiptKind(), `receipt_${dispatch.id}`), idempotent: true };
        }
        const resume = args.resume === true;
        if (dispatch.status === "running" && !resume)
            throw new Error("Internal host dispatch is running; resume requires an explicit resume flag");
        if (dispatch.status !== "prepared" && dispatch.status !== "running")
            throw new Error("Internal host dispatch is not executable");
        const resumedFrom = dispatch.status === "running" ? dispatch.status : null;
        if (resumedFrom) {
            dispatch = this.store.save(this.dispatchKind, String(dispatch.id), { ...payload(dispatch), status: "prepared", resumed_at: new Date().toISOString() });
        }
        const provider = this.provider(dispatch.provider);
        const limits = defineLoopLimits(dispatch.limits);
        let state = beginLoop(Date.now());
        let finalMessage = null;
        let failure = null;
        dispatch = this.store.save(this.dispatchKind, String(dispatch.id), { ...payload(dispatch), status: "running", started_at: new Date().toISOString(), ...(resumedFrom ? { resumed_from: resumedFrom } : {}) });
        const session = this.store.find("internal_session", `session_${dispatch.id}`);
        let messages = session && Array.isArray(session.messages) ? session.messages : [{ role: "user", content: prompt }];
        const traceId = `runtime:${dispatch.id}`;
        this.trace.start({ trace_id: traceId, task_id: dispatch.task_id, run_id: dispatch.id, model_fingerprint: digest({ provider: provider.provider, model: dispatch.model }), metadata: createWorkNote({ goal: prompt }) });
        try {
            while (state.status === "running") {
                const compacted = compactConversation(messages, 32_000);
                messages = compacted.messages;
                this.store.save("internal_session", `session_${dispatch.id}`, { dispatch_id: dispatch.id, messages, compacted: compacted.compacted, omitted: compacted.omitted, summary_digest: compacted.summary_digest });
                const request = buildChatRequest(provider, { model: String(dispatch.model), messages: messages, tools: this.tools.length ? [...this.tools] : undefined });
                options.observe?.({ stream: "stdout", bytes: request.prompt_tokens_estimate, digest: digest(request.url) });
                this.trace.append({ trace_id: traceId, event_kind: "model.request", source: "internal-host", trust: "observed", summary: "model request", usage: { input_tokens: request.prompt_tokens_estimate }, data: { provider: provider.provider, model: dispatch.model, compacted: compacted.compacted } });
                const result = await this.transport.complete(provider, request);
                const tokens = (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0);
                const parsedCalls = (result.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: (() => { try {
                        return JSON.parse(call.function.arguments || "{}");
                    }
                    catch {
                        throw new Error("tool arguments must be valid JSON");
                    } })() }));
                const proposed = parsedCalls.length ? parsedCalls[0] : parseAction(result.text);
                if (!proposed || !this.invokeAction) {
                    state = completeLoop(state, "model_final_message");
                    finalMessage = result.text || (parsedCalls.length ? `Tool call ${parsedCalls[0].name} not executed` : "");
                    this.trace.append({ trace_id: traceId, event_kind: "model.final", source: "internal-host", trust: "observed", summary: "model final", data: { text_digest: digest(finalMessage) }, usage: result.usage ?? {} });
                    break;
                }
                const action = "action" in proposed ? proposed.action : proposed.name;
                const actionArgs = "args" in proposed ? proposed.args : proposed.arguments;
                const outcome = await this.invokeAction(action, actionArgs);
                messages.push({ role: "assistant", content: result.text || null, ...(result.tool_calls ? { tool_calls: result.tool_calls } : {}) });
                messages.push("id" in proposed ? toolResultMessage(proposed.id, outcome) : { role: "user", content: JSON.stringify(outcome) });
                this.trace.append({ trace_id: traceId, event_kind: "tool.call", source: "internal-host", trust: "observed", summary: action, data: { action, args_digest: digest(actionArgs), outcome_digest: digest(outcome) } });
                const observed = observeStep(state, limits, { action, args: actionArgs,
                    progress_digest: digest(outcome), tokens, now: Date.now() });
                state = observed.state;
                if (observed.halted) {
                    finalMessage = `Halted: ${observed.halt_reason}`;
                    break;
                }
                if (options.signal?.aborted) {
                    state = failLoop(state, "cancelled");
                    failure = "cancelled";
                    break;
                }
            }
        }
        catch (error) {
            state = failLoop(state, error instanceof Error ? error.name : "UnknownError");
            failure = error instanceof Error ? error.message : "Internal host failed";
        }
        const succeeded = state.status === "completed" && failure === null;
        const status = succeeded ? "completed" : "failed";
        const receiptPayload = { dispatch_id: dispatch.id, task_id: dispatch.task_id, host: this.host,
            provider: provider.provider, model: dispatch.model, status, loop: loopSummary(state, limits),
            final_message: finalMessage ? redact(finalMessage).slice(-MAX_FINAL_MESSAGE_CHARS) : null,
            failure: failure === null ? null : redact(failure), completed_at: new Date().toISOString() };
        const directory = join(this.store.paths.artifactsDir, this.host);
        await mkdir(directory, { recursive: true });
        const receiptPath = join(directory, `${dispatch.id}.json`);
        await writeFile(receiptPath, `${JSON.stringify(receiptPayload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        const receipt = this.store.create(this.receiptKind(), `receipt_${dispatch.id}`, { ...receiptPayload, uri: pathToFileURL(receiptPath).toString(), digest: digest(receiptPayload) });
        const saved = this.store.save(this.dispatchKind, String(dispatch.id), { ...payload(dispatch), status,
            receipt_id: receipt.id, finished_at: receiptPayload.completed_at });
        this.trace.finalize({ trace_id: traceId, status: status === "completed" ? "completed" : "failed", summary: status === "completed" ? "internal host completed" : (failure ?? "internal host failed") });
        this.store.appendEvent(`task:${dispatch.task_id}`, "host.completed", { host: this.host, dispatch_id: dispatch.id,
            receipt_id: receipt.id, status });
        return { dispatch: saved, receipt, idempotent: false };
    }
}
//# sourceMappingURL=internal-host-driver.js.map