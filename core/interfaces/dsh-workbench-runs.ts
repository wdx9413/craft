import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { CraftStore, JsonObject } from "../infrastructure/store.ts";
import { WorkbenchAgentSessionLinks } from "../application/use-cases/workbench-agent-session-links.ts";
import { DshAcpClient, type DshAcpEvent, type DshAcpSession } from "./dsh-acp-client.ts";
import type { DshLaunch } from "../dsh-executable.ts";

type RunState = "running" | "completed" | "failed" | "unknown";
type RunEvent = { sequence: number; event: JsonObject; size: number };
type PendingApproval = {
  id: string;
  requestId: string | number;
  sessionId: string;
  toolCall: JsonObject;
  options: JsonObject[];
};
type Run = {
  runId: string;
  taskId: string;
  linkId: string;
  sessionId: string;
  operationId: string;
  state: RunState;
  reason: string | null;
  events: RunEvent[];
  bytes: number;
  sequence: number;
  approvals: Map<string, PendingApproval>;
  nativeSessionId: string;
};

export type DshCreate = {
  task_id: string;
  workspace: string;
  prompt: string;
  operation_id: string;
  permission: "ask" | "read_only" | "auto" | "full";
  model?: string | null;
  reasoning_effort?: string | null;
};

export type DshSend = {
  task_id: string;
  link_id: string;
  prompt: string;
  operation_id: string;
  work_mode?: unknown;
};

const MAX_EVENT_BYTES = 256 * 1024;
const MAX_RUN_BYTES = 2 * 1024 * 1024;
const MAX_RUNS = 64;

function required(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function operation(value: unknown): string {
  const result = required(value, "operation_id");
  if (result.length > 256) throw new Error("operation_id is invalid");
  return result;
}

function prompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0") || Buffer.byteLength(value) > 60 * 1024) {
    throw new Error("prompt is invalid");
  }
  return value;
}

function permission(value: unknown): "ask" | "read_only" | "auto" | "full" {
  if (value !== "ask" && value !== "read_only" && value !== "auto" && value !== "full") throw new Error("DSH permission is unsupported");
  return value;
}

function workspace(value: unknown): string {
  const path = required(value, "workspace");
  if (!isAbsolute(path)) throw new Error("workspace must be absolute");
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory()) throw new Error("workspace must be a directory");
  return canonical;
}

function failureReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/u.test(message)) return "timeout";
  if (/cancel/u.test(message)) return "cancelled";
  if (/exited|closed|process/u.test(message)) return "process_closed";
  return "unknown";
}

/**
 * DSH ACP is a session transport, not a second Craft store. Durable link/turn
 * reservations stay in WorkbenchAgentSessionLinks; provider events are bounded
 * in memory and are never written into a duplicate transcript.
 */
export class DshWorkbenchRuns {
  readonly store: CraftStore;
  readonly links: WorkbenchAgentSessionLinks;
  readonly launch: (() => DshLaunch) | null;
  readonly injectedClient: DshAcpClient | null;
  private client: DshAcpClient | null = null;
  private initializing: Promise<DshAcpClient> | null = null;
  private readonly runs = new Map<string, Run>();
  private readonly bySession = new Map<string, Run>();
  private readonly modelCache = new Map<string, { expires: number; value: JsonObject }>();
  private closed = false;
  private injectedReady = false;

  constructor(store: CraftStore, launch: (() => DshLaunch) | null, client: DshAcpClient | null = null) {
    this.store = store;
    this.links = new WorkbenchAgentSessionLinks(store);
    this.launch = launch;
    this.injectedClient = client;
  }

  async models(workspaceValue: string): Promise<JsonObject> {
    const cwd = workspace(workspaceValue);
    const cached = this.modelCache.get(cwd);
    if (cached && cached.expires > Date.now()) return cached.value;
    const client = await this.ensureClient();
    const session = await client.newSession(cwd, []);
    try {
      const value = normalizeConfigOptions(session.configOptions ?? []);
      this.modelCache.set(cwd, { expires: Date.now() + 5 * 60_000, value });
      return value;
    } finally {
      await client.closeSession(session.sessionId).catch(() => undefined);
    }
  }

  list(taskId: string): JsonObject {
    const task = required(taskId, "task_id");
    return { runs: [...this.runs.values()].filter((run) => run.taskId === task).map((run) => ({
      run_id: run.runId, state: run.state, native_session_id: run.nativeSessionId, link_id: run.linkId,
    })) };
  }

  async nativeSessions(cursor?: string | null, workspaceValue?: string | null): Promise<JsonObject> {
    const client = await this.ensureClient();
    const result = await client.listSessions(cursor, workspaceValue ? workspace(workspaceValue) : null);
    return {
      threads: result.sessions.map((entry) => {
        const value = entry && typeof entry === "object" && !Array.isArray(entry) ? entry as JsonObject : {};
        return { id: String(value.sessionId ?? ""), title: String(value.cwd ?? "DSH 会话"), workspace: String(value.cwd ?? ""), linked_id: null };
      }).filter((entry) => entry.id),
      next_cursor: result.nextCursor,
    };
  }

  async importNative(taskId: string, sessionId: string, workspaceValue: string, permissionValue: unknown = "ask"): Promise<JsonObject> {
    const cwd = workspace(workspaceValue);
    const client = await this.ensureClient();
    const resumed = await client.resumeSession(required(sessionId, "thread_id"), cwd, []);
    const linked = this.links.bind({
      task_id: required(taskId, "task_id"), provider: "dsh", native_session_id: resumed.sessionId,
      workspace: cwd, model: null, permission: permission(permissionValue),
    }).link as JsonObject;
    this.bySession.set(resumed.sessionId, this.runForLink(linked, resumed.sessionId, "", "completed"));
    return { link: linked };
  }

  async resume(taskId: string, linkId: string): Promise<JsonObject> {
    const link = this.links.get(taskId, linkId);
    if (link.provider !== "dsh" || typeof link.native_session_id !== "string") throw new Error("session link is not DSH");
    const client = await this.ensureClient();
    if (!this.bySession.has(link.native_session_id)) {
      await client.resumeSession(link.native_session_id, String(link.workspace), []);
      this.runForLink(link, link.native_session_id, "", "completed");
    }
    return { link };
  }

  async create(args: DshCreate): Promise<JsonObject> {
    if (this.closed) throw new Error("DSH run registry is closed");
    if (this.runs.size >= MAX_RUNS) throw new Error("DSH run registry is full");
    const taskId = required(args.task_id, "task_id");
    this.store.get("task", taskId);
    const cwd = workspace(args.workspace);
    const text = prompt(args.prompt);
    const permissionMode = permission(args.permission);
    const operationId = operation(args.operation_id);
    const markerId = submissionMarker(taskId, "create", operationId);
    this.store.transaction(() => {
      if (this.store.find("workbench_dsh_submission", markerId)) throw new Error("DSH creation operation already used; inspect session before retrying");
      this.store.create("workbench_dsh_submission", markerId, { task_id: taskId, operation_id: operationId, status: "reserved" });
    });

    const client = await this.ensureClient();
    const session = await client.newSession(cwd, []);
    const selectedModel = typeof args.model === "string" && args.model.trim() ? args.model.trim() : null;
    const reasoning = typeof args.reasoning_effort === "string" && args.reasoning_effort.trim() ? args.reasoning_effort.trim() : null;
    try {
      if (selectedModel) await client.setConfigOption(session.sessionId, "model", selectedModel);
      if (reasoning) await client.setConfigOption(session.sessionId, "reasoning_effort", reasoning);
      const link = this.links.bind({ task_id: taskId, provider: "dsh", native_session_id: session.sessionId,
        workspace: cwd, model: selectedModel, permission: permissionMode }).link as JsonObject;
      const run = this.runForLink(link, session.sessionId, operationId, "running");
      this.links.reserveTurn(taskId, String(link.id), operationId);
      this.links.acknowledgeTurn(taskId, String(link.id), operationId, operationId);
      this.startPrompt(client, run, text);
      this.store.transaction(() => {
        const marker = this.store.get("workbench_dsh_submission", markerId);
        this.store.updateIfVersion("workbench_dsh_submission", markerId, Number(marker.version), { ...marker, status: "accepted", link_id: link.id });
      });
      return { run_id: run.runId, link };
    } catch (error) {
      await client.closeSession(session.sessionId).catch(() => undefined);
      throw new Error("DSH creation outcome may be unknown; inspect native session before retrying", { cause: error });
    }
  }

  async send(args: DshSend): Promise<JsonObject> {
    if (args.work_mode !== undefined && args.work_mode !== "default") throw new Error("DSH ACP does not support plan mode");
    const taskId = required(args.task_id, "task_id");
    const linkId = required(args.link_id, "link_id");
    const link = this.links.get(taskId, linkId);
    if (link.provider !== "dsh" || typeof link.native_session_id !== "string") throw new Error("session link is not DSH");
    const operationId = operation(args.operation_id);
    const markerId = submissionMarker(taskId, linkId, operationId);
    this.store.transaction(() => {
      if (this.store.find("workbench_dsh_submission", markerId)) throw new Error("DSH submission operation already used; inspect session before retrying");
      this.store.create("workbench_dsh_submission", markerId, { task_id: taskId, link_id: linkId, operation_id: operationId, status: "reserved" });
      this.links.reserveTurn(taskId, linkId, operationId);
    });
    const client = await this.ensureClient();
    const existing = this.bySession.get(link.native_session_id);
    const run = existing?.linkId === linkId && existing.state === "completed"
      ? this.resetRun(existing, operationId)
      : this.runForLink(link, link.native_session_id, operationId, "running");
    this.links.acknowledgeTurn(taskId, linkId, operationId, operationId);
    this.startPrompt(client, run, prompt(args.prompt));
    return { run_id: run.runId };
  }

  events(taskId: string, runId: string, after: number): JsonObject {
    const run = this.get(taskId, runId);
    if (!Number.isSafeInteger(after) || after < 0 || after > run.sequence) throw new Error("event cursor is invalid");
    const oldest = run.events[0]?.sequence ?? run.sequence + 1;
    return {
      state: run.state,
      reason: run.reason,
      native_session_id: run.nativeSessionId,
      events: run.events.filter((row) => row.sequence > after),
      last_sequence: run.sequence,
      truncated: after < oldest - 1,
      approvals: [...run.approvals.values()].map((approval) => ({
        id: approval.id, request_id: approval.requestId, tool_call: approval.toolCall, options: approval.options,
      })),
    };
  }

  decide(taskId: string, runId: string, requestId: string, decision: "accept" | "decline"): void {
    const run = this.get(taskId, runId);
    const approval = [...run.approvals.values()].find((entry) => String(entry.requestId) === requestId);
    if (!approval) throw new Error("DSH approval is not pending");
    const client = this.client;
    if (!client) throw new Error("DSH client is closed");
    client.respond(approval.requestId, permissionResult(decision));
    run.approvals.delete(approval.id);
  }

  interrupt(taskId: string, runId: string): void {
    const run = this.get(taskId, runId);
    if (run.state !== "running") throw new Error("DSH run is not active");
    if (!this.client) throw new Error("DSH client is closed");
    this.client.cancel(run.sessionId);
  }

  release(taskId: string, runId: string): void {
    const run = this.get(taskId, runId);
    if (run.state === "running") throw new Error("DSH run is still active");
    this.runs.delete(runId);
    if (this.bySession.get(run.sessionId) === run) this.bySession.delete(run.sessionId);
  }

  async configure(taskId: string, linkId: string, modelValue: unknown, permissionValue: unknown): Promise<JsonObject> {
    const link = this.links.get(taskId, linkId);
    if (link.provider !== "dsh") throw new Error("session link is not DSH");
    const model = required(modelValue, "model");
    const permissionMode = permission(permissionValue);
    const client = await this.ensureClient();
    await client.setConfigOption(String(link.native_session_id), "model", model);
    return { link: this.links.configure(taskId, linkId, model, permissionMode) };
  }

  async close(): Promise<void> {
    this.closed = true;
    const client = this.client;
    this.client = null;
    this.initializing = null;
    if (client) {
      const sessions = [...new Set([...this.runs.values()].map((run) => run.sessionId))];
      await Promise.allSettled(sessions.map((sessionId) => client.closeSession(sessionId)));
      client.close();
    }
    for (const run of this.runs.values()) {
      if (run.state === "running") {
        run.state = "unknown";
        run.reason = "process_closed";
      }
    }
  }

  private get(taskId: string, runId: string): Run {
    const run = this.runs.get(required(runId, "run_id"));
    if (!run || run.taskId !== required(taskId, "task_id")) throw new Error("DSH run not found for task");
    return run;
  }

  private async ensureClient(): Promise<DshAcpClient> {
    if (this.closed) throw new Error("DSH run registry is closed");
    if (this.injectedClient) {
      this.client = this.injectedClient;
      if (!this.injectedReady) {
        await this.injectedClient.initialize();
        this.injectedReady = true;
      }
      return this.injectedClient;
    }
    if (this.client) return this.client;
    if (this.initializing) return this.initializing;
    if (!this.launch) throw new Error("DSH launch configuration is unavailable");
    this.initializing = (async () => {
      const client = new DshAcpClient({ launch: this.launch!(), onEvent: (event) => this.receive(event) });
      await client.initialize();
      this.client = client;
      return client;
    })().finally(() => { this.initializing = null; });
    return this.initializing;
  }

  private runForLink(link: JsonObject, sessionId: string, operationId: string, state: RunState): Run {
    const existing = this.bySession.get(sessionId);
    if (existing) {
      existing.linkId = String(link.id);
      existing.operationId = operationId;
      existing.state = state;
      existing.reason = null;
      return existing;
    }
    const run: Run = {
      runId: randomUUID(), taskId: String(link.task_id), linkId: String(link.id), sessionId,
      operationId, state, reason: null, events: [], bytes: 0, sequence: 0, approvals: new Map(),
      nativeSessionId: sessionId,
    };
    this.runs.set(run.runId, run);
    this.bySession.set(sessionId, run);
    return run;
  }

  private resetRun(run: Run, operationId: string): Run {
    run.operationId = operationId;
    run.state = "running";
    run.reason = null;
    run.approvals.clear();
    return run;
  }

  private startPrompt(client: DshAcpClient, run: Run, text: string): void {
    void client.prompt(run.sessionId, text, 0).then((result) => {
      const stopReason = result && typeof result === "object" && !Array.isArray(result)
        ? String((result as JsonObject).stopReason ?? "end_turn") : "end_turn";
      const status = stopReason === "cancelled" ? "interrupted" : stopReason === "end_turn" ? "completed" : "failed";
      run.state = status === "completed" ? "completed" : status === "interrupted" ? "completed" : "failed";
      run.reason = status === "completed" ? null : stopReason;
      this.completeLink(run, status);
    }, (error) => {
      run.state = "unknown";
      run.reason = failureReason(error);
      this.markUnknown(run);
    });
  }

  private completeLink(run: Run, status: "completed" | "failed" | "interrupted"): void {
    try {
      this.links.completeTurn(run.taskId, run.linkId, run.operationId, run.operationId, status);
    } catch {
      this.markUnknown(run);
    }
  }

  private markUnknown(run: Run): void {
    try {
      const link = this.links.get(run.taskId, run.linkId);
      if (link.operation_id === run.operationId && (link.turn_state === "starting" || link.turn_state === "running")) {
        this.links.markTurnUnknown(run.taskId, run.linkId, run.operationId);
      }
    } catch {
      // The original failure remains the authoritative outcome.
    }
  }

  private receive(event: DshAcpEvent): void {
    if (event.type === "closed") {
      for (const run of this.runs.values()) {
        if (run.state === "running") {
          run.state = "unknown";
          run.reason = "process_closed";
          this.markUnknown(run);
        }
      }
      this.client = null;
      return;
    }
    if (event.type === "notification" && event.method === "session/update") {
      const params = objectValue(event.params);
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      const run = this.bySession.get(sessionId);
      if (!run) return;
      this.append(run, { type: "session_update", update: params.update ?? null });
      return;
    }
    if (event.type === "request" && event.method === "session/request_permission") {
      const params = objectValue(event.params);
      const sessionId = typeof params.sessionId === "string" ? params.sessionId : "";
      const run = this.bySession.get(sessionId);
      if (!run) {
        this.client?.respondError(event.id, "unknown DSH session");
        return;
      }
      const link = this.links.get(run.taskId, run.linkId);
      const options = Array.isArray(params.options) ? params.options as JsonObject[] : [];
      if (link.permission === "auto" || link.permission === "full") {
        this.client?.respond(event.id, permissionResult("accept", options));
        return;
      }
      if (link.permission === "read_only") {
        this.client?.respond(event.id, permissionResult("decline", options));
        return;
      }
      const approval: PendingApproval = {
        id: randomUUID(),
        requestId: event.id,
        sessionId,
        toolCall: objectValue(params.toolCall),
        options,
      };
      run.approvals.set(approval.id, approval);
      this.append(run, { type: "permission_request", approval_id: approval.id, request_id: event.id,
        tool_call: approval.toolCall, options });
    }
  }

  private append(run: Run, event: JsonObject): void {
    const size = Buffer.byteLength(JSON.stringify(event));
    if (size > MAX_EVENT_BYTES) {
      run.state = "unknown";
      run.reason = "event_too_large";
      this.markUnknown(run);
      return;
    }
    run.events.push({ sequence: ++run.sequence, event, size });
    run.bytes += size;
    while (run.events.length > 256 || run.bytes > MAX_RUN_BYTES) run.bytes -= run.events.shift()!.size;
  }
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function submissionMarker(taskId: string, linkId: string, operationId: string): string {
  return `dsh_submit_${createHash("sha256").update(JSON.stringify([taskId, linkId, operationId])).digest("hex")}`;
}

function permissionResult(decision: "accept" | "decline", options: JsonObject[] = []): JsonObject {
  if (decision === "decline") {
    const reject = options.find((option) => option.kind === "reject_once" || option.optionId === "reject-once");
    return { outcome: { outcome: "selected", optionId: String(reject?.optionId ?? "reject-once") } };
  }
  const allow = options.find((option) => option.kind === "allow_once" || option.optionId === "allow-once");
  return { outcome: { outcome: "selected", optionId: String(allow?.optionId ?? "allow-once") } };
}

export function normalizeConfigOptions(options: unknown[]): JsonObject {
  const models: JsonObject[] = [];
  const reasoning: JsonObject[] = [];
  for (const raw of options) {
    const option = objectValue(raw);
    if (option.id === "model" && Array.isArray(option.options)) {
      for (const groupValue of option.options) {
        const group = objectValue(groupValue);
        const groupName = typeof group.name === "string" ? group.name : typeof group.group === "string" ? group.group : "模型";
        for (const itemValue of Array.isArray(group.options) ? group.options : []) {
          const item = objectValue(itemValue);
          if (typeof item.value !== "string") continue;
          models.push({ id: item.value, name: typeof item.name === "string" ? item.name : item.value,
            group: groupName, description: typeof item.description === "string" ? item.description : null });
        }
      }
    }
    if (option.id === "reasoning_effort" && Array.isArray(option.options)) {
      for (const itemValue of option.options) {
        const item = objectValue(itemValue);
        if (typeof item.value !== "string") continue;
        reasoning.push({ id: item.value, name: typeof item.name === "string" ? item.name : item.value,
          description: typeof item.description === "string" ? item.description : null });
      }
    }
  }
  return { models, reasoning_efforts: reasoning, config_options: options };
}

