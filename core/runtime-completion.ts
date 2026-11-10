import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir, readdir, stat, lstat, realpath, rename } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { fallback, object, optionalText, text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";



function list(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const values = value.map((item) => text(item, name));
  if (new Set(values).size !== values.length) throw new Error(`${name} must contain unique values`);
  return values;
}



const EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive"]);
const IGNORED_DIRECTORIES = new Set([".git", ".hg", ".svn", "node_modules", "dist", "build", ".cache", ".craft_data", ".pnpm-store"]);

function contained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !rel.startsWith("/"));
}

function globPattern(value: unknown): RegExp | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 256 || value.includes("\0")) throw new Error("glob is invalid");
  let source = "";
  for (let index = 0; index < value.length; index++) {
    const char = value[index]!;
    if (char === "*") {
      if (value[index + 1] === "*") { source += ".*"; index++; }
      else source += "[^/]*";
    } else if (char === "?") source += "[^/]";
    else source += char.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`^${source}$`, "u");
}

/** v0.12.13 bounded action gateway. The default adapter never executes shell or remote effects. */
export class ActionGatewayKernel {
  readonly store: CraftStore;
  readonly dataRoot: string;
  constructor(store: CraftStore, dataRoot?: string) {
    this.store = store;
    this.dataRoot = dataRoot ?? join(homedir(), ".craft_data");
  }

  prepare(args: JsonObject): JsonObject {
    const actionId = String(fallback(args.action_id, `action_${randomUUID().replaceAll("-", "")}`));
    const effect = text(args.effect ?? "read_only", "effect");
    if (!EFFECTS.has(effect)) throw new Error("Unsupported action effect");
    const contract = { task_id: text(args.task_id, "task_id"), workspace: text(args.workspace, "workspace"), operation: text(args.operation, "operation"), effect, input_digest: text(args.input_digest, "input_digest"), approval_ref: optionalText(args.approval_ref, "approval_ref") };
    const actionDigest = digestJson(contract); const existing = this.store.find("action_gateway", actionId);
    if (existing) { if (existing.action_digest !== actionDigest) throw new Error("Action idempotency conflict"); return { action: existing, idempotent: true }; }
    return { action: this.store.create("action_gateway", actionId, { ...contract, action_digest: actionDigest, status: "prepared" }), idempotent: false };
  }

  execute(args: JsonObject): Promise<JsonObject> {
    return this.executeAsync(args);
  }

  private async executeAsync(args: JsonObject): Promise<JsonObject> {
    const action = this.store.get("action_gateway", text(args.action_id, "action_id"));
    if (action.status === "completed") return { action, idempotent: true };
    if (action.status !== "prepared") throw new Error("Action is not executable");
    const effect = String(action.effect);
    if (effect !== "read_only" && args.approved !== true) throw new Error("Write actions require explicit approval");
    const workspace = resolve(text(action.workspace, "workspace"));
    const dataRoot = resolve(this.dataRoot);
    const operation = String(action.operation);
    const relativePath = text(fallback(args.relative_path, ""), "relative_path");
    const inWorkspace = isAbsolute(relativePath)
      ? false
      : !relative(workspace, resolve(workspace, relativePath)).startsWith("..");
    const inDataRoot = isAbsolute(relativePath) && !relative(dataRoot, resolve(relativePath)).startsWith("..");
    if (!inWorkspace && !inDataRoot) throw new Error("Action path escapes workspace and Craft data root");
    const target = inWorkspace ? resolve(workspace, relativePath) : resolve(relativePath);
    if (operation === "workspace_read") {
      const content = await readFile(target, "utf8");
      const result = { operation, path: relativePath, content, result_digest: digestJson(content) };
      return this.finish(action, result);
    }
    if (operation === "workspace_write") {
      if (effect !== "local_write") throw new Error("workspace_write requires local_write effect");
      const content = text(args.content, "content");
      await mkdir(resolve(target, ".."), { recursive: true }); await writeFile(target, content, "utf8");
      return this.finish(action, { operation, path: relativePath, bytes: Buffer.byteLength(content), result_digest: digestJson(content) });
    }
    if (operation === "workspace_list") {
      if (effect !== "read_only") throw new Error("workspace_list requires read_only effect");
      const root = await realpath(workspace);
      const start = await this.safeExistingPath(root, relativePath || ".");
      if (!(await stat(start)).isDirectory()) throw new Error("workspace_list target must be a directory");
      const depth = Math.max(0, Math.min(8, Number(args.depth ?? 1)));
      const maxEntries = Math.max(1, Math.min(2_000, Number(args.max_entries ?? 200)));
      const entries: JsonObject[] = [];
      const visit = async (directory: string, currentDepth: number): Promise<void> => {
        if (entries.length >= maxEntries) return;
        const children = await readdir(directory, { withFileTypes: true });
        for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
          if (entries.length >= maxEntries) return;
          if (IGNORED_DIRECTORIES.has(child.name)) continue;
          const absolute = resolve(directory, child.name);
          if (!contained(root, absolute)) continue;
          const itemStat = await lstat(absolute);
          entries.push({ path: relative(root, absolute).replaceAll("\\", "/"), type: itemStat.isDirectory() ? "directory" : itemStat.isFile() ? "file" : "other",
            size: itemStat.isFile() ? itemStat.size : null, modified_at: itemStat.mtime.toISOString() });
          if (itemStat.isDirectory() && currentDepth < depth) await visit(absolute, currentDepth + 1);
        }
      };
      await visit(start, 0);
      const result = { operation, path: relativePath || ".", entries, truncated: entries.length >= maxEntries, result_digest: digestJson(entries) };
      return this.finish(action, result);
    }
    if (operation === "workspace_search") {
      if (effect !== "read_only") throw new Error("workspace_search requires read_only effect");
      const query = text(args.query, "query");
      if (query.length > 500 || query.includes("\0")) throw new Error("query is invalid");
      const root = await realpath(workspace);
      const start = await this.safeExistingPath(root, relativePath || ".");
      const matcher = globPattern(args.glob);
      const regex = args.regex === true;
      let expression: RegExp;
      try { expression = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), regex ? "u" : "iu"); }
      catch { throw new Error("query is not a valid regular expression"); }
      const maxResults = Math.max(1, Math.min(500, Number(args.max_results ?? 50)));
      const maxFileBytes = Math.max(1_024, Math.min(4 * 1024 * 1024, Number(args.max_file_bytes ?? 1024 * 1024)));
      const maxTotalBytes = Math.max(maxFileBytes, Math.min(32 * 1024 * 1024, Number(args.max_total_bytes ?? 8 * 1024 * 1024)));
      const matches: JsonObject[] = [];
      let scanned = 0;
      const visit = async (directory: string, depth: number): Promise<void> => {
        if (matches.length >= maxResults || scanned >= maxTotalBytes || depth > 16) return;
        const children = await readdir(directory, { withFileTypes: true });
        for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
          if (matches.length >= maxResults || scanned >= maxTotalBytes) return;
          if (IGNORED_DIRECTORIES.has(child.name)) continue;
          const absolute = resolve(directory, child.name);
          if (!contained(root, absolute)) continue;
          const itemStat = await lstat(absolute);
          if (itemStat.isSymbolicLink()) continue;
          if (itemStat.isDirectory()) { await visit(absolute, depth + 1); continue; }
          if (!itemStat.isFile() || itemStat.size > maxFileBytes) continue;
          const relativePathValue = relative(root, absolute).replaceAll("\\", "/");
          if (matcher && !matcher.test(relativePathValue)) continue;
          const buffer = await readFile(absolute);
          scanned += buffer.byteLength;
          if (buffer.subarray(0, 8_192).includes(0)) continue;
          const content = buffer.toString("utf8");
          const lines = content.split(/\r?\n/u);
          for (let lineIndex = 0; lineIndex < lines.length && matches.length < maxResults; lineIndex++) {
            const line = lines[lineIndex]!;
            expression.lastIndex = 0;
            if (!expression.test(line)) continue;
            matches.push({ path: relativePathValue, line: lineIndex + 1, preview: line.slice(0, 240) });
          }
        }
      };
      await visit(start, 0);
      const result = { operation, query, matches, truncated: matches.length >= maxResults || scanned >= maxTotalBytes, scanned_bytes: scanned, result_digest: digestJson(matches) };
      return this.finish(action, result);
    }
    if (operation === "workspace_patch") {
      if (effect !== "local_write") throw new Error("workspace_patch requires local_write effect");
      const expectedDigest = text(args.expected_digest, "expected_digest");
      const edits = Array.isArray(args.edits) ? args.edits : [];
      if (!edits.length || edits.length > 100) throw new Error("edits must contain 1..100 replacements");
      const root = await realpath(workspace);
      const target = await this.safeExistingPath(root, relativePath);
      const targetStat = await lstat(target);
      if (!targetStat.isFile() || targetStat.isSymbolicLink()) throw new Error("workspace_patch target must be a regular file");
      const before = await readFile(target, "utf8");
      if (digestJson(before) !== expectedDigest) throw new Error("workspace_patch expected_digest does not match current content");
      let after = before;
      for (const [index, raw] of edits.entries()) {
        const edit = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as JsonObject : null;
        if (!edit) throw new Error(`edits[${index}] must be an object`);
        const oldText = text(edit.old_text, `edits[${index}].old_text`);
        const newText = typeof edit.new_text === "string" ? edit.new_text : (() => { throw new Error(`edits[${index}].new_text must be a string`); })();
        if (!oldText) throw new Error(`edits[${index}].old_text must not be empty`);
        const occurrences = after.split(oldText).length - 1;
        if (occurrences === 0) throw new Error(`edits[${index}].old_text was not found`);
        if (edit.replace_all !== true && occurrences !== 1) throw new Error(`edits[${index}].old_text is ambiguous`);
        after = edit.replace_all === true ? after.split(oldText).join(newText) : after.replace(oldText, newText);
      }
      const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, after, { encoding: "utf8", mode: targetStat.mode });
      await rename(temporary, target);
      const result = { operation, path: relativePath, before_digest: digestJson(before), after_digest: digestJson(after),
        bytes: Buffer.byteLength(after), result_digest: digestJson(after) };
      return this.finish(action, result);
    }
    if (operation === "shell" || operation === "mcp_call" || operation === "browser") throw new Error(`${operation} requires an explicit platform adapter`);
    throw new Error(`Unsupported action operation: ${operation}`);
  }

  private finish(action: JsonObject, result: JsonObject): JsonObject {
    const receipt = this.store.create("action_receipt", `receipt_${action.id}`, { action_id: action.id, operation: action.operation, effect: action.effect, result_digest: result.result_digest, observed: true });
    const saved = this.store.save("action_gateway", String(action.id), { ...payload(action), status: "completed", receipt_id: receipt.id, result_digest: result.result_digest });
    return { action: saved, receipt, result, idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { action: this.store.get("action_gateway", text(args.action_id, "action_id")) }; }

  private async safeExistingPath(root: string, relativePath: string): Promise<string> {
    const candidate = resolve(root, relativePath);
    if (!contained(root, candidate)) throw new Error("Action path escapes workspace");
    const canonical = await realpath(candidate);
    if (!contained(root, canonical)) throw new Error("Action path escapes workspace");
    return canonical;
  }
}

/** Independent acceptance gate. Host completion is never a passing verdict. */
export class AcceptanceGateKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  prepare(args: JsonObject): JsonObject {
    const gateId = String(fallback(args.gate_id, `acceptance_gate_${randomUUID().replaceAll("-", "")}`));
    const identity = { task_id: text(args.task_id, "task_id"), work_id: text(args.work_id, "work_id"), acceptance_ref: text(args.acceptance_ref, "acceptance_ref"), required_artifact_ids: list(args.required_artifact_ids, "required_artifact_ids"), required_evidence_ids: list(args.required_evidence_ids, "required_evidence_ids") };
    const gateDigest = digestJson(identity); const existing = this.store.find("acceptance_gate", gateId);
    if (existing) { if (existing.gate_digest !== gateDigest) throw new Error("Acceptance Gate idempotency conflict"); return { gate: existing, idempotent: true }; }
    return { gate: this.store.create("acceptance_gate", gateId, { ...identity, gate_digest: gateDigest, status: "pending" }), idempotent: false };
  }

  assess(args: JsonObject): JsonObject {
    const gate = this.store.get("acceptance_gate", text(args.gate_id, "gate_id"));
    if (gate.status === "passed" || gate.status === "failed" || gate.status === "blocked") return { gate, idempotent: true };
    const verdict = text(args.verdict, "verdict"); if (!(new Set(["passed", "failed", "blocked"]).has(verdict))) throw new Error("Unsupported acceptance verdict");
    const artifactIds = list(args.artifact_ids, "artifact_ids"); const evidenceIds = list(args.evidence_ids, "evidence_ids");
    if (verdict === "passed" && (!artifactIds.length || !evidenceIds.length)) throw new Error("Passed acceptance requires artifacts and evidence");
    const saved = this.store.save("acceptance_gate", String(gate.id), { ...payload(gate), status: verdict, artifact_ids: artifactIds, evidence_ids: evidenceIds, assessment_digest: digestJson({ verdict, artifactIds, evidenceIds }), assessor: text(args.assessor ?? "program", "assessor") });
    return { gate: saved, idempotent: false };
  }

  outcome(args: JsonObject): JsonObject {
    const gate = this.store.get("acceptance_gate", text(args.gate_id, "gate_id"));
    if (gate.status !== "passed") throw new Error("Outcome requires a passed Acceptance Gate");
    const id = `verified_outcome_${gate.work_id}`; const existing = this.store.find("verified_outcome", id);
    if (existing) return { outcome: existing, idempotent: true };
    return { outcome: this.store.create("verified_outcome", id, { task_id: gate.task_id, work_id: gate.work_id, gate_id: gate.id, verdict: "passed", summary: text(args.summary ?? "Acceptance passed", "summary"), artifact_ids: gate.artifact_ids, evidence_ids: gate.evidence_ids, outcome_digest: digestJson(gate) }), idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { gate: this.store.get("acceptance_gate", text(args.gate_id, "gate_id")) }; }
}

/** Local Worker lease/recovery state; a tray or OS service remains the host that calls tick. */
export class DurableWorkerKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  configure(args: JsonObject = {}): JsonObject {
    const workerId = String(fallback(args.worker_id, "craft-worker")); const existing = this.store.find("durable_worker", workerId);
    const worker = { worker_id: workerId, startup: String(args.startup ?? "manual"), notification: String(args.notification ?? "disabled"), lease_ttl_ms: Number(args.lease_ttl_ms ?? 30_000), status: existing?.status ?? "stopped" };
    return { worker: existing ? this.store.save("durable_worker", workerId, { ...payload(existing), ...worker }) : this.store.create("durable_worker", workerId, worker), idempotent: false };
  }

  start(args: JsonObject = {}): JsonObject { const worker = this.store.find("durable_worker", String(fallback(args.worker_id, "craft-worker"))) ?? this.configure(args).worker as JsonObject; if (worker.status === "running") return { worker, idempotent: true }; return { worker: this.store.save("durable_worker", String(worker.id), { ...payload(worker), status: "running", started_at: new Date().toISOString() }), idempotent: false }; }
  stop(args: JsonObject = {}): JsonObject { const worker = this.store.get("durable_worker", String(fallback(args.worker_id, "craft-worker"))); if (worker.status === "stopped") return { worker, idempotent: true }; return { worker: this.store.save("durable_worker", String(worker.id), { ...payload(worker), status: "stopped", stopped_at: new Date().toISOString() }), idempotent: false }; }

  enqueue(args: JsonObject): JsonObject { const workerId = String(fallback(args.worker_id, "craft-worker")); const jobId = String(fallback(args.job_id, `job_${randomUUID().replaceAll("-", "")}`)); const existing = this.store.find("worker_job", jobId); if (existing) return { job: existing, idempotent: true }; return { job: this.store.create("worker_job", jobId, { worker_id: workerId, task_id: text(args.task_id, "task_id"), action: text(args.action, "action"), status: "pending", payload_digest: digestJson(fallback(args.payload, {})) }), idempotent: false }; }
  tick(args: JsonObject = {}): JsonObject { const worker = this.store.get("durable_worker", String(fallback(args.worker_id, "craft-worker"))); if (worker.status !== "running") return { worker, jobs: [], skipped: true }; const now = String(fallback(args.now, new Date().toISOString())); const jobs = this.store.list("worker_job", 100, (item) => item.worker_id === worker.id && item.status === "pending").map((job) => this.store.save("worker_job", String(job.id), { ...payload(job), status: "leased", lease_id: `lease_${job.id}`, leased_at: now })); const saved = this.store.save("durable_worker", String(worker.id), { ...payload(worker), last_tick_at: now, processed_count: Number(worker.processed_count ?? 0) + jobs.length }); return { worker: saved, jobs, skipped: false }; }
  recover(args: JsonObject = {}): JsonObject { const worker = this.store.get("durable_worker", String(fallback(args.worker_id, "craft-worker"))); const now = Date.parse(String(fallback(args.now, new Date().toISOString()))); const recovered = this.store.list("worker_job", 100, (item) => item.worker_id === worker.id && item.status === "leased" && Date.parse(String(item.leased_at)) + Number(worker.lease_ttl_ms) < now).map((job) => this.store.save("worker_job", String(job.id), { ...payload(job), status: "pending", lease_id: null, recovered_at: new Date(now).toISOString() })); return { recovered, count: recovered.length }; }
  get(args: JsonObject = {}): JsonObject { return { worker: this.store.get("durable_worker", String(fallback(args.worker_id, "craft-worker"))), jobs: this.store.list("worker_job", 100, (item) => item.worker_id === String(fallback(args.worker_id, "craft-worker"))) }; }
}

/** Provider routing policy; transport remains injected by the selected Host. */
export class ProviderRouterKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  plan(args: JsonObject): JsonObject {
    const providers = list(args.providers, "providers"); if (!providers.length) throw new Error("providers must not be empty");
    const preferred = args.preferred === undefined ? providers[0] : text(args.preferred, "preferred"); if (!providers.includes(preferred)) throw new Error("preferred provider must be declared");
    const routeId = String(fallback(args.route_id, `provider_route_${randomUUID().replaceAll("-", "")}`)); const identity = { providers, preferred, fallback: providers.filter((item) => item !== preferred), task_id: args.task_id ?? null, budget_digest: digestJson(fallback(args.budget, {})) };
    const existing = this.store.find("provider_route", routeId); if (existing) { if (existing.route_digest !== digestJson(identity)) throw new Error("Provider route idempotency conflict"); return { route: existing, idempotent: true }; }
    return { route: this.store.create("provider_route", routeId, { ...identity, route_digest: digestJson(identity), status: "planned" }), idempotent: false };
  }
  record(args: JsonObject): JsonObject { const route = this.store.get("provider_route", text(args.route_id, "route_id")); const provider = text(args.provider, "provider"); if (!(route.providers as string[]).includes(provider)) throw new Error("Provider is not in the route"); const saved = this.store.save("provider_route", String(route.id), { ...payload(route), status: args.status === undefined ? "used" : text(args.status, "status"), selected_provider: provider, usage: args.usage === undefined ? null : object(args.usage, "usage") }); return { route: saved, idempotent: false }; }
  get(args: JsonObject): JsonObject { return { route: this.store.get("provider_route", text(args.route_id, "route_id")) }; }
}

/** Full protocol-shaped A2A calls. Raw remote content is never stored. */
export class A2AProtocolKernel {
  async sendMessage(args: JsonObject, fetchImpl: typeof fetch = fetch): Promise<JsonObject> { return this.request(args, "message/send", { message_digest: text(args.message_digest, "message_digest"), context_id: args.context_id ?? null }, fetchImpl); }
  async listTasks(args: JsonObject, fetchImpl: typeof fetch = fetch): Promise<JsonObject> { return this.request(args, "tasks/list", { page_token: args.page_token ?? null }, fetchImpl); }
  async streamMessage(args: JsonObject, fetchImpl: typeof fetch = fetch): Promise<JsonObject> { const result = await this.request(args, "message/stream", { message_digest: text(args.message_digest, "message_digest"), context_id: args.context_id ?? null }, fetchImpl); return { ...result, streaming: true }; }
  private async request(args: JsonObject, operation: string, body: JsonObject, fetchImpl: typeof fetch): Promise<JsonObject> { const endpoint = text(args.endpoint, "endpoint"); if (!endpoint.startsWith("https://")) throw new Error("A2A endpoint must use HTTPS"); const response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", method: operation, params: body, id: text(args.request_id ?? randomUUID(), "request_id") }) }); if (!response.ok) throw new Error(`A2A ${operation} failed: HTTP ${response.status}`); const value = await response.json() as JsonObject; return { operation, response_digest: digestJson(value), task_id: value.task_id ?? null, status: value.status ?? "accepted", raw_content: false }; }
}
