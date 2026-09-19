import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chargeTurn, completeLoop, defineLoopLimits, failLoop, beginLoop, loopSummary, observeStep, type LoopState } from "./agent-loop.ts";
import type { HostDriver, HostOutputObserver } from "./host-driver.ts";
import { buildChatRequest, credentialStatus, parseChatResponse, selectModel, createFetchTransport,
  type ChatMessage, type ChatToolDefinition, type ModelProviderSpec, type ModelTier, type ModelTransport } from "./model-gateway.ts";
import { compactConversation, createWorkNote, summarizeConversation, toolResultMessage, truncateToolResult, type ConversationMessage } from "./runtime-truth.ts";
import { TraceKernel } from "./trace-kernel.ts";
import { estimateTokens } from "./token-budget.ts";
import type { Tool } from "./mcp/tool-schema.ts";
import { DEFAULT_INTERNAL_AUTHORIZATION, internalToolDefinitions, type ToolAuthorization } from "./internal-tool-authorization.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";

/**
 * The internal host: Craft running the loop itself.
 *
 * This is deliberately a *third* HostDriver rather than a new execution model.
 * Codex, Claude and the internal host all produce the same dispatch, receipt and
 * evidence records, so "Craft works on its own" and "Craft governs someone
 * else's agent" stay the same shape and can be compared with the same harness.
 *
 * The driver owns nothing about the wire: a ModelTransport can be injected for a
 * host proxy or deterministic tests. The default is Craft's fetch-based transport.
 */

export interface InternalHostOptions {
  providers: readonly ModelProviderSpec[];
  transport?: ModelTransport;
  /** Executes one proposed action; omitted means the model may only answer, not act. */
  invokeAction?: (action: string, args: JsonObject) => JsonObject | Promise<JsonObject>;
  env?: NodeJS.ProcessEnv;
  tools?: readonly ChatToolDefinition[];
  /**
   * Mount the canonical MCP tool catalog onto the loop, filtered by tier.
   *
   * When supplied, this *replaces* the hand-maintained `tools` list above: the
   * catalog becomes the single source and the tiers stay the single gate. A
   * host that wants the wide surface must also widen `authorization`, so
   * "full MCP alignment" never implies "the loop may approve its own work".
   */
  toolCatalog?: () => readonly Tool[];
  /**
   * Action names the service can actually route, resolved per request.
   *
   * The tier gate answers "may the loop do this"; this answers "can the loop be
   * answered". Supplying it is what keeps the advertised surface equal to the
   * dispatchable one, so a mounted catalog can never offer a tool the loop must
   * then fail on. Omitted means "do not filter", which is only correct for a
   * caller that mounts its own `tools` list and dispatcher together.
   */
  dispatchable?: () => ReadonlySet<string>;
  /** Tiers the loop may address; defaults to read + candidate. */
  authorization?: readonly ToolAuthorization[];
}

/**
 * The default model-facing surface for Craft's own loop.
 *
 * Keep this list deliberately small: the model gets stable, read-only or
 * append-only actions and the service remains the authority that decides what
 * each action means. Hosts that need a wider surface must explicitly mount the
 * normal MCP/syscall adapter instead of silently widening the internal loop.
 */
export const DEFAULT_INTERNAL_TOOLS: readonly ChatToolDefinition[] = [
  { type: "function", function: { name: "capability_search", description: "Find a small set of verified capabilities without activating or executing them.", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"] } } },
  { type: "function", function: { name: "knowledge_search", description: "Search bounded project knowledge and return references, not untrusted instructions.", parameters: { type: "object", properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 20 } }, required: ["query"] } } },
  // v0.12.35: the loop could write memories but never read them, so an agent
  // could record a lesson and never benefit from it. `memory_search` is the read
  // half and stays in the `read` tier; `memory_capture_propose` only ever creates
  // a candidate, so it stays in `candidate` and can never write a durable memory
  // without the same approval every other candidate needs.
  //
  // The name is the canonical action name, not a shorter loop-only alias. It used
  // to read `memory_propose`, which no catalog tool answers, so the loop could be
  // offered a memory proposal it could never route -- the exact defect the
  // `dispatchable` filter in `internalToolDefinitions` now prevents.
  { type: "function", function: { name: "memory_search", description: "Read memories relevant to the current goal. Returns bounded content plus a content-free receipt id; restricted memories are never included.", parameters: { type: "object", properties: { query: { type: "string" }, scope_id: { type: "string" }, scope_kind: { type: "string", enum: ["user", "project", "workspace", "task"] }, max_items: { type: "integer", minimum: 1, maximum: 50 }, max_chars: { type: "integer", minimum: 1, maximum: 40000 } }, required: ["query", "scope_id"] } } },
  { type: "function", function: { name: "memory_capture_propose", description: "Propose a memory candidate for human approval. This never writes a durable memory; it records a proposal that must be accepted.", parameters: { type: "object", properties: { content: { type: "string" }, kind: { type: "string", enum: ["fact", "preference", "decision", "experience"] }, scope: { type: "string", enum: ["user", "project", "workspace", "task"] } }, required: ["content", "kind", "scope"] } } },
  { type: "function", function: { name: "task_checkpoint", description: "Append a content-light progress checkpoint for the current task.", parameters: { type: "object", properties: { task_id: { type: "string" }, summary: { type: "string" }, status: { type: "string" }, completed: { type: "array", items: { type: "string" } }, pending: { type: "array", items: { type: "string" } } }, required: ["task_id", "summary"] } } },
  { type: "function", function: { name: "evidence_record", description: "Record an evidence reference or observation without storing raw sensitive content.", parameters: { type: "object", properties: { claim: { type: "string" }, source_type: { type: "string" }, confidence: { type: "string" }, locator: { type: "string" } }, required: ["claim", "source_type"] } } },
  { type: "function", function: { name: "artifact_register", description: "Register a digest-only artifact reference for later acceptance or review.", parameters: { type: "object", properties: { kind: { type: "string" }, name: { type: "string" }, uri: { type: "string" } }, required: ["kind", "name", "uri"] } } },
  // v0.12.36: the loop's own verification sensor. Without it the loop could only
  // learn from an `outcome` someone else supplied, so it could never recognise
  // its own mistakes. These compare facts the loop already observed (exit codes,
  // expected output, content digests) and execute nothing, which is what makes
  // the read tier honest for them.
  { type: "function", function: { name: "verification_evaluate", description: "Evaluate deterministic checks into one verdict: any failed check fails the plan, and an unevaluable check is blocked rather than passed. Compare bytes you already observed; this executes nothing.", parameters: { type: "object", properties: { checks: { type: "array", items: { type: "object", properties: { kind: { type: "string", enum: ["exit_code", "output_contains", "output_matches", "file_digest", "file_absent"] }, name: { type: "string" }, expected_exit_code: { type: "integer" }, observed_exit_code: { type: "integer" }, expected_substring: { type: "string" }, expected_pattern: { type: "string" }, observed_output: { type: "string" }, expected_digest: { type: "string" }, observed_digest: { type: "string" }, observed_present: { type: "boolean" } }, required: ["kind", "name"] } } }, required: ["checks"] } } },
  { type: "function", function: { name: "verification_capture_signals_get", description: "Convert your own check results into the capture decision's outcome, so a lesson is recorded from an observed failure instead of a reported one.", parameters: { type: "object", properties: { checks: { type: "array", items: { type: "object" } }, retries: { type: "integer", minimum: 0 } }, required: ["checks"] } } },
  // v0.12.37: read across past trajectories, not just the current one. The loop
  // may observe recurrence; it may NOT mint an abstraction (`abstraction_build`
  // is governed), because generalising is a claim about the future.
  { type: "function", function: { name: "abstraction_evaluate", description: "Look across past trajectories for a failure signature that recurs independently of the current run. Reports the recurring groups and why any near-miss was refused.", parameters: { type: "object", properties: { trajectories: { type: "array", items: { type: "object" } } }, required: ["trajectories"] } } },
  // v0.12.38: name the cause of a failure instead of only knowing it happened.
  // A single undifferentiated "it went wrong" cannot be fixed at the right layer.
  { type: "function", function: { name: "failure_attribution_get", description: "Attribute a failure to the layer that caused it, using only signals you actually observed. Returns `unattributed` when the observations do not distinguish a cause; that is a valid answer, not an error.", parameters: { type: "object", properties: { evidence_already_in_input: { type: "boolean", description: "True when the content you treated as a memory was already in the current input, which makes the recall claim circular." }, source_contained_answer: { type: "boolean" }, relevant_retrieved: { type: "boolean" }, answer_in_context: { type: "boolean" }, fact_extracted: { type: "boolean" }, superseded_by_newer: { type: "boolean" }, wrong_scope_applied: { type: "boolean" }, wrong_time_applied: { type: "boolean" }, answer_wrong_with_full_context: { type: "boolean" } } } } },
  // v0.12.39: compare a claim against the implementation before trusting the
  // claim. `unverifiable` is reported rather than folded into "fine".
  { type: "function", function: { name: "consistency_check", description: "Check declarations against observed implementation facts. Each claim is confirmed, contradicted, or unverifiable; an unchecked claim is never reported as passing.", parameters: { type: "object", properties: { declarations: { type: "array", items: { type: "object" } }, observed: { type: "object" } }, required: ["declarations", "observed"] } } },
  // v0.12.40: verify the guardrail is still in context. The loop may CHECK a
  // standing constraint but never DEFINE one — a guard it can redefine is not a
  // guard.
  { type: "function", function: { name: "governance_pin_check", description: "Verify that the pinned governance constraints are still present and unchanged in your context. Detects both a dropped rule and a reworded one; report a failure instead of continuing.", parameters: { type: "object", properties: { constraints: { type: "array", items: { type: "object" } }, rendered: { type: "string" } }, required: ["constraints", "rendered"] } } },
  { type: "function", function: { name: "workspace_read", description: "Read one file inside the declared workspace; path traversal and oversized reads are rejected.", parameters: { type: "object", properties: { task_id: { type: "string" }, workspace: { type: "string" }, relative_path: { type: "string" } }, required: ["task_id", "workspace", "relative_path"] } } },
  { type: "function", function: { name: "workspace_write", description: "Write one file inside the declared workspace. Requires an explicit approved=true flag and local_write effect.", parameters: { type: "object", properties: { task_id: { type: "string" }, workspace: { type: "string" }, relative_path: { type: "string" }, content: { type: "string" }, approved: { type: "boolean" } }, required: ["task_id", "workspace", "relative_path", "content", "approved"] } } },
];

/**
 * The loop-only operations that have no canonical MCP tool.
 *
 * The internal host predates the public catalog with an approval-gated
 * `workspace_read` / `workspace_write` pair: the write path is bounded, local,
 * and still requires `approved: true`, so it belongs in the loop's `candidate`
 * tier rather than being dropped when the catalog becomes the source of truth.
 * Keeping them here, not in the catalog, preserves "the catalog is the public
 * contract" while the loop keeps the exact surface it was already granted.
 */
export const INTERNAL_ONLY_TOOLS: readonly ChatToolDefinition[] = DEFAULT_INTERNAL_TOOLS.filter(
  (definition) => definition.function.name === "workspace_read" || definition.function.name === "workspace_write",
);

function redact(value: string): string { return value.replace(/(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]+/giu, "[redacted]"); }

const MAX_FINAL_MESSAGE_CHARS = 4_000;
const MAX_SESSION_MESSAGE_CHARS = 2_000;
function persistedConversation(messages: ConversationMessage[]): JsonObject[] {
  return messages.map((message) => {
    const raw = message.content === null ? "" : message.content;
    return { role: message.role, content: redact(raw).slice(0, MAX_SESSION_MESSAGE_CHARS), content_digest: digestJson(raw), tool_calls_digest: message.tool_calls ? digestJson(message.tool_calls) : null };
  });
}

/**
 * A model reply is only treated as an action when it is a single JSON object with
 * `action` and optional `args`.
 *
 * The cast on the parsed value is deliberate rather than defensive: a text that
 * starts with `{` and ends with `}` can only parse to an object, so an
 * `Array.isArray` / null guard here would be unreachable code that still counts
 * against the coverage gate. Every other shape returns null before this point.
 */
export function parseAction(text: string): { action: string; args: JsonObject } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(trimmed); } catch { return null; }
  const body = parsed as JsonObject;
  if (typeof body.action !== "string" || !body.action.trim()) return null;
  const args = body.args;
  if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) return null;
  return { action: body.action.trim(), args: (args ?? {}) as JsonObject };
}

export class InternalHostDriver implements HostDriver {
  readonly host = "internal";
  readonly dispatchKind = "internal_dispatch";
  readonly store: CraftStore;
  readonly providers: readonly ModelProviderSpec[];
  readonly transport: ModelTransport;
  readonly invokeAction: InternalHostOptions["invokeAction"];
  readonly env: NodeJS.ProcessEnv;
  readonly authorization: readonly ToolAuthorization[];
  readonly trace: TraceKernel;

  /** The hand-maintained surface, used only when no catalog provider is mounted. */
  readonly #staticTools: readonly ChatToolDefinition[];
  /** Live catalog provider; resolved per request so a later mount is visible. */
  readonly #catalog: (() => readonly Tool[]) | undefined;
  /** Actions the service can route, resolved per request. */
  readonly #dispatchable: (() => ReadonlySet<string>) | undefined;

  /**
   * The model-facing surface for the next request.
   *
   * Deliberately a getter rather than a constructor-time constant: a host mounts
   * its MCP server *after* the driver exists, so freezing this at construction
   * would pin the standalone surface forever. Resolving per request is also what
   * lets `dispatchable` be a live answer instead of a snapshot.
   */
  get tools(): readonly ChatToolDefinition[] {
    if (!this.#catalog) return this.#staticTools;
    return internalToolDefinitions(this.#catalog, this.authorization, INTERNAL_ONLY_TOOLS, this.#dispatchable);
  }

  constructor(store: CraftStore, options: InternalHostOptions) {
    if (!options.providers.length) throw new Error("The internal host requires at least one declared provider");
    this.store = store; this.providers = options.providers; this.env = options.env ?? process.env;
    this.authorization = options.authorization ?? DEFAULT_INTERNAL_AUTHORIZATION;
    this.#catalog = options.toolCatalog;
    this.#dispatchable = options.dispatchable;
    this.#staticTools = options.tools ?? [];
    this.trace = new TraceKernel(store);
    this.transport = options.transport ?? createFetchTransport({ env: this.env }); this.invokeAction = options.invokeAction;
  }

  private receiptKind(): string { return "internal_receipt"; }

  private provider(name: unknown): ModelProviderSpec {
    const wanted = typeof name === "string" && name.trim() ? name.trim() : this.providers[0].provider;
    const found = this.providers.find((spec) => spec.provider === wanted);
    if (!found) throw new Error(`Unknown model provider: ${wanted}`);
    return found;
  }

  /**
   * One routed action, and never an exception.
   *
   * An action can be refused by the tier gate, unknown to dispatch, or rejected
   * by its own validation. All three are facts the model should see rather than
   * reasons to abandon the run: the message is returned as the tool's outcome and
   * the loop continues. Errors are redacted like any other content, so a refusal
   * never leaks the credential it was refused for.
   */
  private async runAction(action: string, args: JsonObject): Promise<JsonObject> {
    try {
      // The caller only reaches here with a dispatcher mounted, so a guard would
      // be unreachable code that still counts against the coverage gate. A
      // dispatcher that answers with nothing still yields an object, because a
      // missing tool result is an invalid transcript, not an empty one.
      const outcome = await this.invokeAction!(action, args) as JsonObject;
      return outcome ?? {};
    } catch (error) {
      return { error: redact(error instanceof Error ? error.message : String(error)) };
    }
  }

  prepare(args: JsonObject): JsonObject {
    const task = this.store.get("task", text(args.task_id, "task_id"));
    const prompt = text(args.prompt, "prompt");
    const provider = this.provider(args.provider);
    const tier = String(args.tier ?? "standard") as ModelTier;
    const selected = selectModel(provider, tier);
    const limits = defineLoopLimits((args.limits ?? {}) as JsonObject);
    const dispatchId = String(args.dispatch_id ?? `internal_dispatch_${randomUUID().replaceAll("-", "")}`);
    const identity = { host: this.host, task_id: task.id, task_version: task.version, provider: provider.provider,
      model: selected.model, tier: selected.tier, downgraded: selected.downgraded, limits, prompt_digest: digestJson(prompt),
      session_id: args.session_id === undefined ? null : text(args.session_id, "session_id"),
      context_digest: args.context_digest === undefined ? null : text(args.context_digest, "context_digest"),
      acceptance_ref: args.acceptance_ref === undefined ? null : text(args.acceptance_ref, "acceptance_ref") };
    const requestDigest = digestJson(identity);
    const existing = this.store.find(this.dispatchKind, dispatchId);
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new Error("Internal host dispatch idempotency conflict");
      return { dispatch: existing, idempotent: true, credential: credentialStatus(provider, this.env) };
    }
    return { dispatch: this.store.create(this.dispatchKind, dispatchId, { ...identity, request_digest: requestDigest,
      status: "prepared", effect: "read_only" }), idempotent: false, credential: credentialStatus(provider, this.env) };
  }

  async execute(args: JsonObject, options: { signal?: AbortSignal; observe?: HostOutputObserver } = {}): Promise<JsonObject> {
    let dispatch = this.store.get(this.dispatchKind, text(args.dispatch_id, "dispatch_id"));
    const prompt = text(args.prompt, "prompt");
    if (digestJson(prompt) !== dispatch.prompt_digest) throw new Error("Internal host prompt does not match the prepared digest");
    if (dispatch.status === "completed" || dispatch.status === "failed") {
      return { dispatch, receipt: this.store.get(this.receiptKind(), `receipt_${dispatch.id}`), idempotent: true };
    }
    const resume = args.resume === true;
    if (dispatch.status === "running" && !resume) throw new Error("Internal host dispatch is running; resume requires an explicit resume flag");
    if (dispatch.status !== "prepared" && dispatch.status !== "running") throw new Error("Internal host dispatch is not executable");
    const resumedFrom = dispatch.status === "running" ? dispatch.status : null;
    if (resumedFrom) {
      dispatch = this.store.save(this.dispatchKind, String(dispatch.id), { ...payload(dispatch), status: "prepared", resumed_at: new Date().toISOString() });
    }
    const provider = this.provider(dispatch.provider);
    const limits = defineLoopLimits(dispatch.limits as JsonObject);
    let state = beginLoop(Date.now());
    let finalMessage: string | null = null;
    let failure: string | null = null;
    dispatch = this.store.save(this.dispatchKind, String(dispatch.id), { ...payload(dispatch), status: "running", started_at: new Date().toISOString(), ...(resumedFrom ? { resumed_from: resumedFrom } : {}) });

    const session = this.store.find("internal_session", `session_${dispatch.id}`);
    let messages: ConversationMessage[] = session && Array.isArray(session.messages)
      ? (session.messages as JsonObject[]).map((item) => ({ role: String(item.role) as ConversationMessage["role"], content: typeof item.content === "string" ? redact(item.content) : null }))
      : [{ role: "user", content: redact(prompt) }];
    const traceId = `runtime:${dispatch.id}`;
    this.trace.start({ trace_id: traceId, task_id: dispatch.task_id, run_id: dispatch.id, model_fingerprint: digestJson({ provider: provider.provider, model: dispatch.model }), metadata: createWorkNote({ goal: prompt }) });
    try {
      while (state.status === "running") {
        // The compaction budget is the loop's own token limit, so context control
        // and cost control are the same decision instead of two unrelated numbers
        // (this used to be a 32,000 *character* ceiling while `max_tokens` was
        // declared elsewhere and never enforced here).
        const compacted = compactConversation(messages, {
          budget: { estimate: estimateTokens, maxTokens: limits.max_context_tokens },
          // Stage two is rule-based and local: a readable note over the dropped
          // turns, with no extra model call to pay for.
          summarize: summarizeConversation,
        });
        messages = compacted.messages;
        this.store.save("internal_session", `session_${dispatch.id}`, { dispatch_id: dispatch.id, messages: persistedConversation(messages), compacted: compacted.compacted, omitted: compacted.omitted, summary_digest: compacted.summary_digest, content_free: true });
        const tools = this.tools;
        const request = buildChatRequest(provider, { model: String(dispatch.model), messages: messages as ChatMessage[], tools: tools.length ? [...tools] : undefined });
        options.observe?.({ stream: "stdout", bytes: request.prompt_tokens_estimate, digest: digestJson(request.url) });
        this.trace.append({ trace_id: traceId, event_kind: "model.request", source: "internal-host", trust: "observed", summary: "model request", usage: { input_tokens: request.prompt_tokens_estimate }, data: { provider: provider.provider, model: dispatch.model, compacted: compacted.compacted } });
        const result = await this.transport.complete(provider, request);
        const tokens = (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0);
        const parsedCalls = (result.tool_calls ?? []).map((call) => ({ id: call.id, name: call.function.name, arguments: (() => { try { return JSON.parse(call.function.arguments || "{}"); } catch { throw new Error("tool arguments must be valid JSON"); } })() }));
        const proposed = parsedCalls.length ? parsedCalls[0] : parseAction(result.text);
        if (!proposed || !this.invokeAction) {
          // Charge the completing turn before finishing: it was billed like any
          // other, and leaving it out under-reports the run's cost by one turn.
          state = chargeTurn(state, tokens);
          state = completeLoop(state, "model_final_message");
          finalMessage = result.text || (parsedCalls.length ? `Tool call ${parsedCalls[0]!.name} not executed` : "");
          this.trace.append({ trace_id: traceId, event_kind: "model.final", source: "internal-host", trust: "observed", summary: "model final", data: { text_digest: digestJson(finalMessage) }, usage: result.usage ?? {} });
          break;
        }
        const calls: Array<{ id: string | null; action: string; args: JsonObject }> = parsedCalls.length
          ? parsedCalls.map((call) => ({ id: call.id, action: call.name, args: call.arguments as JsonObject }))
          : [{ id: null, action: "action" in proposed ? proposed.action : proposed.name,
              args: ("args" in proposed ? proposed.args : proposed.arguments) as JsonObject }];
        // A turn may propose several calls and every one of them is answered. The
        // assistant message below echoes all of the turn's calls, so leaving any
        // id without a result is not a shortened turn -- it is an invalid
        // transcript that the next request is rejected over. Dropping the rest
        // also silently discarded work the model had already committed to, which
        // is the execution-alignment failure this loop exists to prevent.
        messages.push({ role: "assistant", content: result.text || null, ...(result.tool_calls ? { tool_calls: result.tool_calls } : {}) });
        for (const call of calls) {
          // A refused or failing action is information, not a reason to abandon
          // the run: it comes back as the tool outcome so the next turn can be
          // repaired, and an ordinary validation error cannot end the dispatch.
          const outcome = await this.runAction(call.action, call.args);
          messages.push(call.id === null
            ? { role: "user", content: JSON.stringify(truncateToolResult(outcome)) }
            : toolResultMessage(call.id, outcome));
          this.trace.append({ trace_id: traceId, event_kind: "tool.call", source: "internal-host", trust: "observed",
            summary: call.action, data: { action: call.action, args_digest: digestJson(call.args), outcome_digest: digestJson(outcome) } });
          const observed = observeStep(state, limits, { action: call.action, args: call.args,
            progress_digest: digestJson(outcome), tokens, now: Date.now() });
          state = observed.state;
          if (observed.halted) { finalMessage = `Halted: ${observed.halt_reason}`; break; }
          if (options.signal?.aborted) { state = failLoop(state, "cancelled"); failure = "cancelled"; break; }
        }
        if (state.status !== "running" || options.signal?.aborted) break;
      }
    } catch (error) {
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
    const receipt = this.store.create(this.receiptKind(), `receipt_${dispatch.id}`,
      { ...receiptPayload, uri: pathToFileURL(receiptPath).toString(), digest: digestJson(receiptPayload) });
    const saved = this.store.save(this.dispatchKind, String(dispatch.id), { ...payload(dispatch), status,
      receipt_id: receipt.id, finished_at: receiptPayload.completed_at });
    this.trace.finalize({ trace_id: traceId, status: status === "completed" ? "completed" : "failed", summary: status === "completed" ? "internal host completed" : (failure ?? "internal host failed") });
    this.store.appendEvent(`task:${dispatch.task_id}`, "host.completed", { host: this.host, dispatch_id: dispatch.id,
      receipt_id: receipt.id, status });
    return { dispatch: saved, receipt, idempotent: false };
  }
}
