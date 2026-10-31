import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "../infrastructure/store.ts";
import { WorkbenchAgentSessionLinks } from "../application/use-cases/workbench-agent-session-links.ts";
import { CodexAppServerClient, type CodexServerEvent } from "./codex-app-server-client.ts";
import { CodexWorkbenchAdapter, codexWorkbenchPolicy } from "./codex-workbench-adapter.ts";
import { CodexLinkedTurn } from "./codex-linked-turn.ts";
import { codexGroupHasSessionFile, codexProcessIdentity, sameCodexProcess, externalCodexOwner } from "./codex-process-owner.ts";

type Client = Pick<CodexAppServerClient, "initialize" | "request" | "respond" | "close">;
type Live = { client: Client; adapter: CodexWorkbenchAdapter; linked: CodexLinkedTurn | null; taskId: string; linkId: string; threadId: string; generation: string; sequence: number; events: Array<{ sequence: number; event: CodexServerEvent; size: number }>; eventBytes: number; approvals: Map<string, CodexServerEvent & { type: "request" }>; closed: boolean };
type Options = { task_id: string; workspace: string; model?: string | null; permission: "ask" | "read_only" | "auto" | "full"; operation_id: string };
const CREATE_KIND = "workbench_agent_session_creation";
const SEND_KIND = "workbench_agent_session_submission";
const APPROVALS = new Set(["item/commandExecution/requestApproval", "item/fileChange/requestApproval"]);
const QUESTION = "item/tool/requestUserInput";
const OWNER_KIND = "workbench_codex_process_owner";

/** Owns live transports. Only mappings and operation state are persisted; events stay in memory. */
export class CodexWorkbenchSessions {
  readonly links: WorkbenchAgentSessionLinks;
  readonly store: CraftStore;
  readonly factory: (onEvent: (event: CodexServerEvent) => void) => Client;
  private live = new Map<string, Live>();
  private opening = new Set<string>();
  private pending = new Set<Live>();
  private stopped = false;
  constructor(store: CraftStore, factory: (onEvent: (event: CodexServerEvent) => void) => Client = onEvent => new CodexAppServerClient({ onEvent })) {
    this.store = store; this.links = new WorkbenchAgentSessionLinks(store); this.factory = factory;
  }

  private connection(taskId: string): Live {
    const live = { client: null as unknown as Client, adapter: null as unknown as CodexWorkbenchAdapter, linked: null, taskId, linkId: "", threadId: "", generation: randomUUID(), sequence: 0, events: [], eventBytes: 0, approvals: new Map(), closed: false } as Live;
    live.client = this.factory(event => this.observe(live, event));
    live.adapter = new CodexWorkbenchAdapter(live.client);
    return live;
  }

  private observe(live: Live, event: CodexServerEvent): void {
    try {
    const before = live.linked?.status().link;
    live.linked?.observe(event);
    if (event.type === "closed") { live.closed = true; live.approvals.clear(); }
    else {
      const params = event.params && typeof event.params === "object" ? event.params as JsonObject : {};
      if (!live.threadId || params.threadId !== live.threadId) {
        if (event.type === "request") live.client.close();
        return;
      }
      if (event.type === "request") {
        const link = live.linked?.status().link;
        if ((!APPROVALS.has(event.method) && event.method !== QUESTION) || !link || (APPROVALS.has(event.method) && link.permission !== "ask") || typeof params.turnId !== "string" || !["starting", "running"].includes(String(link.turn_state)) || link.turn_state === "running" && params.turnId !== link.turn_id || live.approvals.size >= 32) { live.client.close(); return; }
        live.approvals.set(JSON.stringify(event.id), event);
      }
      if (event.type === "notification" && event.method === "turn/completed" && before?.turn_state === "running" && live.linked?.status().link.turn_state === "idle") live.approvals.clear();
    }
    const size = Buffer.byteLength(JSON.stringify(event));
    if (size > 256 * 1024) { live.client.close(); return; }
    live.events.push({ sequence: ++live.sequence, event, size }); live.eventBytes += size;
    while (live.events.length > 256 || live.eventBytes > 2 * 1024 * 1024) live.eventBytes -= live.events.shift()!.size;
    } catch { if (!live.closed) { live.closed = true; live.client.close(); } }
  }

  async models(): Promise<JsonObject> {
    if (this.stopped) throw new Error("session manager is closed");
    const live = this.connection("");
    this.pending.add(live);
    try {
      await live.client.initialize();
      if (this.stopped) throw new Error("session manager is closed");
      const response = await live.client.request("model/list", { limit: 100 });
      if (this.stopped) throw new Error("session manager is closed");
      if (!response || typeof response !== "object" || !Array.isArray((response as JsonObject).data)) throw new Error("Invalid Codex model list");
      const data = (response as JsonObject).data as unknown[];
      if (data.length > 100) throw new Error("Codex model list exceeds limit");
      const models = data.filter((item): item is JsonObject => !!item && typeof item === "object" && !Array.isArray(item))
        .filter(item => item.hidden !== true && typeof item.model === "string" && item.model.length > 0 && item.model.length <= 256)
        .map(item => ({ id: item.model, name: typeof item.displayName === "string" ? item.displayName.slice(0, 256) : item.model, is_default: item.isDefault === true }));
      return { models, truncated: !!(response as JsonObject).nextCursor };
    } finally { this.pending.delete(live); live.client.close(); }
  }

  async usage(): Promise<JsonObject> {
    if (this.stopped) throw new Error("session manager is closed");
    const live = this.connection(""); this.pending.add(live);
    try {
      await live.client.initialize();
      if (this.stopped) throw new Error("session manager is closed");
      const result = await live.client.request("account/rateLimits/read", {});
      if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid Codex usage response");
      const data = result as JsonObject;
      return { rate_limits: data.rateLimits ?? null, rate_limits_by_id: data.rateLimitsByLimitId ?? null };
    } finally { this.pending.delete(live); live.client.close(); }
  }

  async skills(workspace: string): Promise<JsonObject> {
    if (this.stopped) throw new Error("session manager is closed");
    const policy = codexWorkbenchPolicy({ workspace, permission: "ask" });
    const live = this.connection(""); this.pending.add(live);
    try {
      await live.client.initialize();
      const response = await live.client.request("skills/list", { cwds: [policy.cwd] });
      if (!response || typeof response !== "object" || Array.isArray(response) || !Array.isArray((response as JsonObject).data)) throw new Error("Invalid Codex skill list");
      const entries = (response as JsonObject).data as JsonObject[];
      const matching = entries.filter(entry => entry && entry.cwd === policy.cwd && Array.isArray(entry.skills));
      if (matching.length !== 1) throw new Error("Codex skill workspace mismatch");
      const skills = matching[0].skills as JsonObject[];
      return { skills: skills.slice(0, 200).filter(item => item && item.enabled === true && typeof item.name === "string" && /^[\w:.-]{1,128}$/u.test(item.name) && typeof item.path === "string" && item.path.length <= 4096).map(item => ({ name: item.name, path: item.path, description: typeof item.description === "string" ? item.description.slice(0, 512) : "", plugin: typeof item.pluginId === "string" ? item.pluginId.slice(0, 256) : null })), truncated: skills.length > 200 };
    } finally { this.pending.delete(live); live.client.close(); }
  }

  private async mentionedSkills(workspace: string, prompt: string): Promise<Array<{ type: "skill"; name: string; path: string }>> {
    const names = [...new Set([...prompt.matchAll(/(?:^|\s)\$([\w:.-]{1,128})(?=\s|$)/gu)].map(match => match[1]))];
    if (!names.length) return [];
    const catalog = await this.skills(workspace), available = catalog.skills as Array<{ name: string; path: string }>;
    return names.flatMap(name => {
      const matches = available.filter(item => item.name === name);
      if (matches.length > 1) throw new Error(`技能名称不唯一：${name}`);
      return matches.length ? [{ type: "skill" as const, name, path: matches[0].path }] : [];
    });
  }

  /** Discover native Codex sessions without attaching a writer or copying transcripts. */
  async nativeSessions(cursor: string | null = null): Promise<JsonObject> {
    if (this.stopped) throw new Error("session manager is closed");
    if (cursor !== null && (cursor.length > 4096 || /[\u0000-\u001f\u007f]/u.test(cursor))) throw new Error("cursor is invalid");
    const live = this.connection(""); this.pending.add(live);
    try {
      await live.client.initialize();
      const response = await live.client.request("thread/list", { limit: 50, sortKey: "updated_at", cursor });
      if (!response || typeof response !== "object" || Array.isArray(response) || !Array.isArray((response as JsonObject).data)) throw new Error("Invalid Codex session list");
      const data = (response as JsonObject).data as unknown[];
      if (data.length > 50) throw new Error("Codex session list exceeds limit");
      const threads = data.filter((item): item is JsonObject => !!item && typeof item === "object" && !Array.isArray(item))
        .filter(item => typeof item.id === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(item.id) && typeof item.cwd === "string" && item.cwd.length <= 4096 && item.ephemeral === false)
        .map(item => {
          const linkId = `agent_session_${createHash("sha256").update(JSON.stringify(["codex", item.id])).digest("hex")}`;
          const link = this.store.find("workbench_agent_session_link", linkId);
          return { id: item.id, workspace: item.cwd, title: typeof item.name === "string" && item.name.trim() ? item.name.slice(0, 160) : typeof item.preview === "string" ? item.preview.slice(0, 160) : "Codex 会话", updated_at: item.updatedAt, linked_task_id: link?.task_id ?? null, linked_id: link?.id ?? null };
        });
      const next = (response as JsonObject).nextCursor;
      if (next !== null && next !== undefined && (typeof next !== "string" || next.length > 4096)) throw new Error("Invalid Codex session cursor");
      return { threads, next_cursor: next ?? null };
    } finally { this.pending.delete(live); live.client.close(); }
  }

  /** Re-read identity from Codex before linking an existing session. */
  async importNative(taskId: string, threadId: string): Promise<JsonObject> {
    if (this.stopped) throw new Error("session manager is closed");
    this.store.get("task", taskId);
    if (typeof threadId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/u.test(threadId)) throw new Error("thread id is invalid");
    const live = this.connection(taskId); this.pending.add(live);
    try {
      await live.client.initialize();
      const result = await live.client.request("thread/read", { threadId, includeTurns: false });
      const thread = result && typeof result === "object" && !Array.isArray(result) ? (result as JsonObject).thread : null;
      if (!thread || typeof thread !== "object" || Array.isArray(thread)) throw new Error("Invalid Codex thread");
      const native = thread as JsonObject;
      if (native.id !== threadId || native.ephemeral !== false || typeof native.cwd !== "string") throw new Error("Codex thread identity could not be verified");
      return this.links.bind({ task_id: taskId, provider: "codex", native_session_id: threadId, workspace: native.cwd, model: typeof native.model === "string" && native.model.trim() ? native.model : null, permission: "ask" });
    } finally { this.pending.delete(live); live.client.close(); }
  }

  async create(options: Options): Promise<JsonObject> {
    if (this.stopped) throw new Error("session manager is closed");
    if (typeof options.operation_id !== "string" || !options.operation_id.trim() || options.operation_id.length > 256 || /[\u0000-\u001f\u007f]/u.test(options.operation_id)) throw new Error("operation_id is invalid");
    this.store.get("task", options.task_id);
    const policy = codexWorkbenchPolicy(options);
    const identity = { task_id: options.task_id, workspace: policy.cwd, model: policy.model, permission: options.permission };
    const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
    const id = `agent_create_${createHash("sha256").update(JSON.stringify([options.task_id, options.operation_id])).digest("hex")}`;
    const existing = this.store.find(CREATE_KIND, id);
    if (existing) return this.existingCreation(existing, digest);
    let marker: JsonObject;
    try { marker = this.store.create(CREATE_KIND, id, { ...identity, identity_digest: digest, status: "starting" }); }
    catch (error) { const raced = this.store.find(CREATE_KIND, id); if (!raced) throw error; return this.existingCreation(raced, digest); }
    const live = this.connection(options.task_id);
    this.pending.add(live);
    try {
      await live.client.initialize();
      if (this.stopped) throw new Error("session manager is closed");
      const native = await live.adapter.start(options);
      if (this.stopped) throw new Error("session manager is closed");
      live.threadId = native.thread_id;
      const link = this.store.transaction(() => {
        const bound = this.links.bind({ ...identity, provider: "codex", native_session_id: native.thread_id, model: native.model }).link as JsonObject;
        this.store.updateIfVersion(CREATE_KIND, id, Number(marker.version), { ...marker, status: "complete", link_id: bound.id });
        return bound;
      });
      live.linkId = String(link.id); live.linked = new CodexLinkedTurn(this.links, live.adapter, live.taskId, live.linkId);
      this.rememberOwner(live);
      this.live.set(live.linkId, live);
      return { link, idempotent: false };
    } catch (error) { live.client.close(); throw new Error("Codex session creation outcome may be unknown; do not repeat the same operation", { cause: error }); }
    finally { this.pending.delete(live); }
  }

  private existingCreation(marker: JsonObject, digest: string): JsonObject {
    if (marker.identity_digest !== digest) throw new Error("session creation operation conflicts with previous request");
    if (marker.status !== "complete" || typeof marker.link_id !== "string") throw new Error("session creation outcome is unknown; reconcile before retrying");
    return { link: this.links.get(marker.task_id, marker.link_id), idempotent: true };
  }

  async resume(taskId: string, linkId: string): Promise<JsonObject> {
    if (this.stopped) throw new Error("session manager is closed");
    const link = this.links.get(taskId, linkId);
    if (link.provider !== "codex") throw new Error("session link is not Codex");
    const current = this.live.get(linkId);
    if (current && !current.closed) return current.linked!.status();
    if (this.opening.has(linkId)) throw new Error("session is already opening");
    this.opening.add(linkId);
    let live: Live | undefined;
    try {
      live = this.connection(taskId); this.pending.add(live); live.linkId = linkId; live.threadId = String(link.native_session_id);
      await live.client.initialize();
      if (this.stopped) throw new Error("session manager is closed");
      await live.adapter.resume(live.threadId, { workspace: String(link.workspace), model: link.model as string | null, permission: link.permission as "ask" | "read_only" | "auto" | "full" });
      if (this.stopped) throw new Error("session manager is closed");
      live.linked = new CodexLinkedTurn(this.links, live.adapter, taskId, linkId);
      this.rememberOwner(live);
      this.live.set(linkId, live);
      return live.linked.status();
    } catch (error) {
      live?.client.close();
      if (error instanceof Error && error.message.includes("already has an active writer")) throw new Error("该 Codex 会话正由其他进程使用，请先在原窗口结束运行并退出，再恢复会话", { cause: error });
      throw error;
    }
    finally { if (live) this.pending.delete(live); this.opening.delete(linkId); }
  }

  private rememberOwner(live: Live): void {
    const pid = (live.client as Partial<CodexAppServerClient>).process?.pid;
    const identity = codexProcessIdentity(pid);
    if (!identity) return;
    const old = this.store.find(OWNER_KIND, live.linkId);
    const value = { ...identity, task_id: live.taskId, link_id: live.linkId, thread_id: live.threadId };
    if (old) this.store.updateIfVersion(OWNER_KIND, live.linkId, Number(old.version), value);
    else this.store.create(OWNER_KIND, live.linkId, value);
  }

  takeoverCandidate(taskId: string, linkId: string): JsonObject {
    const link = this.links.get(taskId, linkId);
    const owner = this.store.find(OWNER_KIND, linkId);
    if (link.provider !== "codex") return { available: false };
    if (this.live.get(linkId) && !this.live.get(linkId)!.closed) return { available: false };
    if (owner && owner.task_id === taskId && owner.thread_id === link.native_session_id && sameCodexProcess(owner) && codexGroupHasSessionFile(owner, link.native_session_id)) return { available: true, pid: owner.pid, started: owner.started, source: "craft" };
    const external = externalCodexOwner(link.native_session_id);
    return external ? { available: true, ...external, source: "external" } : { available: false };
  }

  async takeover(taskId: string, linkId: string, pid: unknown, started: unknown, sessionCount?: unknown): Promise<JsonObject> {
    const candidate = this.takeoverCandidate(taskId, linkId);
    if (!candidate.available || candidate.pid !== pid || candidate.started !== started || typeof pid !== "number") throw new Error("进程身份已变化或无法确认，请重新检查会话");
    if (candidate.source === "external" && candidate.session_count !== sessionCount) throw new Error("占用的会话数量已变化，请重新检查会话");
    const link = this.links.get(taskId, linkId);
    const owner = candidate.source === "craft" ? this.store.get(OWNER_KIND, linkId) : externalCodexOwner(link.native_session_id);
    if (!owner || owner.pid !== pid || owner.started !== started || (candidate.source === "craft" && (!sameCodexProcess(owner) || !codexGroupHasSessionFile(owner, owner.thread_id))) || (candidate.source === "external" && (owner.executable !== candidate.executable || owner.session_count !== candidate.session_count))) throw new Error("进程身份已变化，请重新检查会话");
    if ((link.turn_state === "starting" || link.turn_state === "running") && typeof link.operation_id === "string") this.links.markTurnUnknown(taskId, linkId, link.operation_id);
    process.kill(candidate.source === "craft" && process.platform !== "win32" ? -pid : pid, "SIGTERM");
    for (let i = 0; i < 30; i++) {
      if (process.platform === "win32" && !(() => { try { process.kill(pid, 0); return true; } catch { return false; } })()) return { stopped: true };
      if (candidate.source === "craft" ? !sameCodexProcess(owner) && !codexGroupHasSessionFile(owner, owner.thread_id) : externalCodexOwner(link.native_session_id)?.pid !== pid) return { stopped: true };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error("进程尚未退出，请稍后重试或在原窗口退出");
  }

  private connected(taskId: string, linkId: string): Live {
    this.links.get(taskId, linkId);
    const live = this.live.get(linkId);
    if (!live || live.closed || !live.linked) throw new Error("session is not connected");
    return live;
  }

  async send(taskId: string, linkId: string, prompt: string, operationId: string, workMode?: unknown) {
    const live = this.connected(taskId, linkId);
    if (typeof operationId !== "string" || !operationId.trim() || operationId.length > 256 || /[\u0000-\u001f\u007f]/u.test(operationId)) throw new Error("operation_id is invalid");
    if (typeof prompt !== "string" || !prompt.trim() || prompt.includes("\0") || Buffer.byteLength(prompt) > 60 * 1024) throw new Error("prompt is invalid");
    if (workMode !== undefined && workMode !== "default" && workMode !== "plan") throw new Error("work mode is invalid");
    const model = this.links.get(taskId, linkId).model;
    if (workMode === "plan" && (typeof model !== "string" || !model)) throw new Error("model is required for plan mode");
    const skills = /(?:^|\s)\$[\w:.-]{1,128}(?=\s|$)/u.test(prompt) ? await this.mentionedSkills(String(this.links.get(taskId, linkId).workspace), prompt) : [];
    const id = `agent_send_${createHash("sha256").update(JSON.stringify([taskId, linkId, operationId])).digest("hex")}`;
    if (this.store.find(SEND_KIND, id)) throw new Error("submission operation already used; inspect session before retrying");
    let marker: JsonObject;
    try { marker = this.store.create(SEND_KIND, id, { task_id: taskId, link_id: linkId, submission_id: operationId, native_session_id: this.links.get(taskId, linkId).native_session_id, status: "starting" }); }
    catch (error) { if (this.store.find(SEND_KIND, id)) throw new Error("submission operation already used; inspect session before retrying"); throw error; }
    try {
      const link = this.links.get(taskId, linkId);
      const policy = codexWorkbenchPolicy({ workspace: String(link.workspace), model: link.model as string | null, permission: link.permission as "ask" | "read_only" | "auto" | "full" });
      const result = await live.linked!.send(prompt, skills, workMode === undefined || typeof link.model !== "string" || !link.model ? undefined : { mode: workMode, model: link.model }, policy);
      this.store.updateIfVersion(SEND_KIND, id, Number(marker.version), { ...marker, status: "accepted", turn_id: result.turn_id });
      if (result.link.turn_state === "idle") live.approvals.clear();
      return result;
    } catch (error) { throw new Error("submission outcome may be unknown; inspect session before retrying", { cause: error }); }
  }

  async steer(taskId: string, linkId: string, prompt: string, operationId: string) {
    const live = this.connected(taskId, linkId); const link = this.links.get(taskId, linkId);
    if (link.turn_state !== "running" || typeof link.turn_id !== "string") throw new Error("session has no active turn to steer");
    if (typeof operationId !== "string" || !operationId.trim() || operationId.length > 256 || /[\u0000-\u001f\u007f]/u.test(operationId)) throw new Error("operation_id is invalid");
    if (typeof prompt !== "string" || !prompt.trim() || prompt.includes("\0") || Buffer.byteLength(prompt) > 60 * 1024) throw new Error("prompt is invalid");
    const skills = /(?:^|\s)\$[\w:.-]{1,128}(?=\s|$)/u.test(prompt) ? await this.mentionedSkills(String(link.workspace), prompt) : [];
    const marker = `codex_steer_${createHash("sha256").update(JSON.stringify([taskId, linkId, operationId])).digest("hex")}`;
    if (this.store.find("workbench_codex_steer", marker)) throw new Error("steer operation already used; inspect session before retrying");
    const record = this.store.create("workbench_codex_steer", marker, { task_id: taskId, link_id: linkId, submission_id: operationId, native_session_id: link.native_session_id, status: "starting" });
    try {
      await live.adapter.steer(live.threadId, link.turn_id, prompt, skills);
      this.store.updateIfVersion("workbench_codex_steer", marker, Number(record.version), { ...record, status: "accepted" });
      return { accepted: true };
    } catch (error) { throw new Error("steer outcome may be unknown; inspect session before retrying", { cause: error }); }
  }
  async interrupt(taskId: string, linkId: string): Promise<void> {
    const live = this.connected(taskId, linkId); const link = this.links.get(taskId, linkId);
    if (link.turn_state !== "running" || typeof link.turn_id !== "string") throw new Error("session has no interruptible turn");
    await live.adapter.interrupt(live.threadId, link.turn_id);
  }
  async goal(taskId: string, linkId: string, objective?: string): Promise<JsonObject> {
    const live = this.connected(taskId, linkId);
    if (objective !== undefined && (typeof objective !== "string" || !objective.trim() || objective.includes("\0") || Buffer.byteLength(objective) > 60 * 1024)) throw new Error("goal is invalid");
    const result = await live.client.request(objective === undefined ? "thread/goal/get" : "thread/goal/set", objective === undefined ? { threadId: live.threadId } : { threadId: live.threadId, objective, origin: "user" });
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("invalid goal response");
    return result as JsonObject;
  }
  async history(taskId: string, linkId: string): Promise<JsonObject> {
    const live = this.connected(taskId, linkId);
    const thread = await live.adapter.history(live.threadId);
    if (Buffer.byteLength(JSON.stringify(thread)) > 2 * 1024 * 1024) throw new Error("Codex history exceeds display limit");
    return { thread };
  }
  async reconcile(taskId: string, linkId: string): Promise<JsonObject> {
    const live = this.connected(taskId, linkId);
    const link = this.links.get(taskId, linkId);
    if (!['running', 'unknown'].includes(String(link.turn_state)) || typeof link.turn_id !== 'string' || typeof link.operation_id !== 'string') throw new Error('no identifiable unsettled turn');
    const thread = (await this.history(taskId, linkId)).thread as JsonObject;
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    const matches = turns.filter((turn): turn is JsonObject => !!turn && typeof turn === 'object' && !Array.isArray(turn) && (turn as JsonObject).id === link.turn_id);
    if (matches.length !== 1 || !['completed', 'failed', 'interrupted'].includes(String(matches[0].status))) throw new Error('native history does not prove a terminal turn');
    const settled = this.links.completeTurn(taskId, linkId, link.operation_id, link.turn_id, matches[0].status);
    live.approvals.clear();
    return { link: settled };
  }
  decide(taskId: string, linkId: string, requestId: string | number, decision: "accept" | "decline"): void {
    const live = this.connected(taskId, linkId); const key = JSON.stringify(requestId);
    const request = live.approvals.get(key); const link = this.links.get(taskId, linkId);
    const params = request?.params as JsonObject | undefined;
    if (!request || !APPROVALS.has(request.method) || link.turn_state !== "running" || params?.turnId !== link.turn_id) throw new Error("approval is not pending for this session");
    live.adapter.decide(requestId, decision); live.approvals.delete(key);
  }
  answer(taskId: string, linkId: string, requestId: string | number, answers: unknown): void {
    const live = this.connected(taskId, linkId); const key = JSON.stringify(requestId);
    const request = live.approvals.get(key); const link = this.links.get(taskId, linkId);
    const params = request?.params as JsonObject | undefined;
    if (!request || !params || request.method !== QUESTION || link.turn_state !== "running" || params.turnId !== link.turn_id) throw new Error("question is not pending for this session");
    if (!answers || typeof answers !== "object" || Array.isArray(answers) || !Array.isArray(params.questions) || params.questions.length === 0 || params.questions.length > 10) throw new Error("answers are invalid");
    const supplied = answers as Record<string, unknown>; const result: Record<string, { answers: string[] }> = Object.create(null);
    for (const question of params.questions) {
      if (!question || typeof question !== "object" || Array.isArray(question) || typeof question.id !== "string" || Object.hasOwn(result, question.id)) throw new Error("question is invalid");
      const value = supplied[question.id];
      if (!Object.hasOwn(supplied, question.id) || !Array.isArray(value) || value.length !== 1 || typeof value[0] !== "string" || !value[0].trim() || value[0].length > 8192) throw new Error("answers are invalid");
      result[question.id] = { answers: value };
    }
    if (Object.keys(supplied).length !== params.questions.length) throw new Error("answers are invalid");
    live.client.respond(requestId, { answers: result }); live.approvals.delete(key);
  }
  events(taskId: string, linkId: string, generation: string | null, after: number): JsonObject {
    this.links.get(taskId, linkId);
    const live = this.live.get(linkId);
    if (!live || !live.linked) throw new Error("session is not connected");
    if ((generation === null && after !== 0) || (generation !== null && generation !== live.generation)) throw new Error("event stream changed; reload session");
    if (!Number.isSafeInteger(after) || after < 0 || after > live.sequence) throw new Error("event cursor is invalid");
    const oldest = live.events[0]?.sequence ?? live.sequence + 1;
    return { generation: live.generation, events: live.events.filter(item => item.sequence > after).map(({ sequence, event }) => ({ sequence, event })), truncated: after < oldest - 1, last_sequence: live.sequence, approvals: [...live.approvals.values()], status: live.linked.status() };
  }
  unlink(taskId: string, linkId: string): void {
    if (this.opening.has(linkId)) throw new Error("session is already opening");
    this.links.unlink(taskId, linkId);
    const live = this.live.get(linkId);
    if (live) { live.client.close(); this.live.delete(linkId); }
  }
  close(): void { this.stopped = true; for (const live of this.pending) live.client.close(); for (const live of this.live.values()) live.client.close(); this.live.clear(); }
}
