import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { homedir } from "node:os";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { object, text } from "./validation.ts";
import { digestJson, payload } from "./digest.ts";



function list(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const values = value.map((item) => text(item, name));
  if (new Set(values).size !== values.length) throw new Error(`${name} must contain unique values`);
  return values;
}



const EFFECTS = new Set(["read_only", "local_write", "external_write", "destructive"]);

/** v0.12.13 bounded action gateway. The default adapter never executes shell or remote effects. */
export class ActionGatewayKernel {
  readonly store: CraftStore;
  readonly dataRoot: string;
  constructor(store: CraftStore, dataRoot?: string) {
    this.store = store;
    this.dataRoot = dataRoot ?? join(homedir(), ".craft_data");
  }

  prepare(args: JsonObject): JsonObject {
    const actionId = String(args.action_id ?? `action_${randomUUID().replaceAll("-", "")}`);
    const effect = text(args.effect ?? "read_only", "effect");
    if (!EFFECTS.has(effect)) throw new Error("Unsupported action effect");
    const contract = { task_id: text(args.task_id, "task_id"), workspace: text(args.workspace, "workspace"), operation: text(args.operation, "operation"), effect, input_digest: text(args.input_digest, "input_digest"), approval_ref: args.approval_ref === undefined ? null : text(args.approval_ref, "approval_ref") };
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
    const relativePath = text(args.relative_path ?? "", "relative_path");
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
    if (operation === "shell" || operation === "mcp_call" || operation === "browser") throw new Error(`${operation} requires an explicit platform adapter`);
    throw new Error(`Unsupported action operation: ${operation}`);
  }

  private finish(action: JsonObject, result: JsonObject): JsonObject {
    const receipt = this.store.create("action_receipt", `receipt_${action.id}`, { action_id: action.id, operation: action.operation, effect: action.effect, result_digest: result.result_digest, observed: true });
    const saved = this.store.save("action_gateway", String(action.id), { ...payload(action), status: "completed", receipt_id: receipt.id, result_digest: result.result_digest });
    return { action: saved, receipt, result, idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { action: this.store.get("action_gateway", text(args.action_id, "action_id")) }; }
}

/** Independent acceptance gate. Host completion is never a passing verdict. */
export class AcceptanceGateKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  prepare(args: JsonObject): JsonObject {
    const gateId = String(args.gate_id ?? `acceptance_gate_${randomUUID().replaceAll("-", "")}`);
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
    const workerId = String(args.worker_id ?? "craft-worker"); const existing = this.store.find("durable_worker", workerId);
    const worker = { worker_id: workerId, startup: String(args.startup ?? "manual"), notification: String(args.notification ?? "disabled"), lease_ttl_ms: Number(args.lease_ttl_ms ?? 30_000), status: existing?.status ?? "stopped" };
    return { worker: existing ? this.store.save("durable_worker", workerId, { ...payload(existing), ...worker }) : this.store.create("durable_worker", workerId, worker), idempotent: false };
  }

  start(args: JsonObject = {}): JsonObject { const worker = this.store.find("durable_worker", String(args.worker_id ?? "craft-worker")) ?? this.configure(args).worker as JsonObject; if (worker.status === "running") return { worker, idempotent: true }; return { worker: this.store.save("durable_worker", String(worker.id), { ...payload(worker), status: "running", started_at: new Date().toISOString() }), idempotent: false }; }
  stop(args: JsonObject = {}): JsonObject { const worker = this.store.get("durable_worker", String(args.worker_id ?? "craft-worker")); if (worker.status === "stopped") return { worker, idempotent: true }; return { worker: this.store.save("durable_worker", String(worker.id), { ...payload(worker), status: "stopped", stopped_at: new Date().toISOString() }), idempotent: false }; }

  enqueue(args: JsonObject): JsonObject { const workerId = String(args.worker_id ?? "craft-worker"); const jobId = String(args.job_id ?? `job_${randomUUID().replaceAll("-", "")}`); const existing = this.store.find("worker_job", jobId); if (existing) return { job: existing, idempotent: true }; return { job: this.store.create("worker_job", jobId, { worker_id: workerId, task_id: text(args.task_id, "task_id"), action: text(args.action, "action"), status: "pending", payload_digest: digestJson(args.payload ?? {}) }), idempotent: false }; }
  tick(args: JsonObject = {}): JsonObject { const worker = this.store.get("durable_worker", String(args.worker_id ?? "craft-worker")); if (worker.status !== "running") return { worker, jobs: [], skipped: true }; const now = String(args.now ?? new Date().toISOString()); const jobs = this.store.list("worker_job", 100, (item) => item.worker_id === worker.id && item.status === "pending").map((job) => this.store.save("worker_job", String(job.id), { ...payload(job), status: "leased", lease_id: `lease_${job.id}`, leased_at: now })); const saved = this.store.save("durable_worker", String(worker.id), { ...payload(worker), last_tick_at: now, processed_count: Number(worker.processed_count ?? 0) + jobs.length }); return { worker: saved, jobs, skipped: false }; }
  recover(args: JsonObject = {}): JsonObject { const worker = this.store.get("durable_worker", String(args.worker_id ?? "craft-worker")); const now = Date.parse(String(args.now ?? new Date().toISOString())); const recovered = this.store.list("worker_job", 100, (item) => item.worker_id === worker.id && item.status === "leased" && Date.parse(String(item.leased_at)) + Number(worker.lease_ttl_ms) < now).map((job) => this.store.save("worker_job", String(job.id), { ...payload(job), status: "pending", lease_id: null, recovered_at: new Date(now).toISOString() })); return { recovered, count: recovered.length }; }
  get(args: JsonObject = {}): JsonObject { return { worker: this.store.get("durable_worker", String(args.worker_id ?? "craft-worker")), jobs: this.store.list("worker_job", 100, (item) => item.worker_id === String(args.worker_id ?? "craft-worker")) }; }
}

/** Provider routing policy; transport remains injected by the selected Host. */
export class ProviderRouterKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }
  plan(args: JsonObject): JsonObject {
    const providers = list(args.providers, "providers"); if (!providers.length) throw new Error("providers must not be empty");
    const preferred = args.preferred === undefined ? providers[0] : text(args.preferred, "preferred"); if (!providers.includes(preferred)) throw new Error("preferred provider must be declared");
    const routeId = String(args.route_id ?? `provider_route_${randomUUID().replaceAll("-", "")}`); const identity = { providers, preferred, fallback: providers.filter((item) => item !== preferred), task_id: args.task_id ?? null, budget_digest: digestJson(args.budget ?? {}) };
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
