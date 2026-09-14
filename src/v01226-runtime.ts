import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { spawn, type ChildProcess } from "node:child_process";
import { platform } from "node:process";
import { parse } from "yaml";
import type { CraftStore, JsonObject } from "./store.ts";

export const RUNTIME_VERSION = "0.12.26";
export type AdapterKind = "command" | "mcp" | "openapi" | "browser" | "host" | "model";
export type AdapterStatus = "active" | "quarantined" | "retired";
export type CommandStatus = "planned" | "running" | "completed" | "failed" | "cancelled";

export type AdapterManifest = {
  schema_version: 1;
  adapter_id: string;
  version: string;
  kind: AdapterKind;
  platforms: string[];
  entry: string;
  transport: string;
  capabilities: string[];
  permissions: string[];
  effects: string[];
  dependencies?: JsonObject;
  integrity?: string;
  signature?: string;
  sandbox_profile?: string;
  status?: AdapterStatus;
  metadata?: JsonObject;
};

type CommandRequest = {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  platform?: string;
  shell?: false | string;
  timeout_ms?: number;
  output_limit?: number;
  effect?: string;
  approval_ref?: string | null;
  adapter_id?: string;
};
export type CommandSpawner = typeof spawn;

const ADAPTER_KINDS = new Set<AdapterKind>(["command", "mcp", "openapi", "browser", "host", "model"]);
const EFFECTS = new Set(["read", "read_only", "local_write", "external_write", "destructive"]);
const ACTIVE_PLATFORMS = new Set(["win32", "darwin", "linux", "freebsd", "any"]);
const now = () => new Date().toISOString();
const digest = (value: unknown) => `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
function required(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function list(value: unknown, name: string, minimum = 0): string[] { if (!Array.isArray(value)) throw new Error(`${name} must be an array`); const result = value.map((item) => required(item, name)); if (result.length < minimum || new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`); return result; }
function integer(value: unknown, name: string, fallback: number, min: number, max: number): number { const result = value === undefined ? fallback : Number(value); if (!Number.isInteger(result) || result < min || result > max) throw new Error(`${name} must be an integer between ${min} and ${max}`); return result; }
function obj(value: unknown, name: string): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`); return value as JsonObject; }

export function defineAdapterManifest(input: Partial<AdapterManifest> & Pick<AdapterManifest, "adapter_id" | "version" | "kind">): AdapterManifest {
  const kind = input.kind;
  if (!ADAPTER_KINDS.has(kind)) throw new Error("kind is unsupported");
  const platforms = input.platforms === undefined ? ["any"] : list(input.platforms, "platforms", 1);
  if (platforms.some((item) => !ACTIVE_PLATFORMS.has(item))) throw new Error("platform is unsupported");
  const effects = input.effects === undefined ? ["read_only"] : list(input.effects, "effects", 1);
  if (effects.some((item) => !EFFECTS.has(item))) throw new Error("effect is unsupported");
  return {
    schema_version: 1, adapter_id: required(input.adapter_id, "adapter_id"), version: required(input.version, "version"), kind,
    platforms, entry: input.entry === undefined ? "builtin" : required(input.entry, "entry"),
    transport: input.transport === undefined ? "local" : required(input.transport, "transport"),
    capabilities: input.capabilities === undefined ? [] : list(input.capabilities, "capabilities"),
    permissions: input.permissions === undefined ? [] : list(input.permissions, "permissions"), effects,
    ...(input.dependencies === undefined ? {} : { dependencies: obj(input.dependencies, "dependencies") }),
    ...(input.integrity === undefined ? {} : { integrity: required(input.integrity, "integrity") }),
    ...(input.signature === undefined ? {} : { signature: required(input.signature, "signature") }),
    ...(input.sandbox_profile === undefined ? {} : { sandbox_profile: required(input.sandbox_profile, "sandbox_profile") }),
    status: input.status ?? "active", ...(input.metadata === undefined ? {} : { metadata: obj(input.metadata, "metadata") }),
  };
}

export class V01226Runtime {
  readonly activeProcesses = new Map<string, ChildProcess>();
  readonly store: CraftStore;
  spawnProcess: CommandSpawner;
  constructor(store: CraftStore, spawnProcess: CommandSpawner = spawn) { this.store = store; this.spawnProcess = spawnProcess; }

  adapterRegister(input: Partial<AdapterManifest> & Pick<AdapterManifest, "adapter_id" | "version" | "kind">): JsonObject {
    const manifest = defineAdapterManifest(input);
    const existing = this.store.find("adapter_manifest", manifest.adapter_id);
    if (existing && existing.manifest_digest !== digest(manifest)) {
      const version = Number(existing.version ?? 0) + 1;
      const saved = this.store.save("adapter_manifest", manifest.adapter_id, { ...manifest, version: manifest.version, previous_version: version, manifest_digest: digest(manifest) });
      return { manifest: saved, idempotent: false };
    }
    if (existing) return { manifest: existing, idempotent: true };
    return { manifest: this.store.create("adapter_manifest", manifest.adapter_id, { ...manifest, manifest_digest: digest(manifest) }), idempotent: false };
  }

  adapterGet(adapterId: string): JsonObject { return this.store.get("adapter_manifest", required(adapterId, "adapter_id")); }
  adapterList(limit = 50): JsonObject { return { adapters: this.store.list("adapter_manifest", integer(limit, "limit", 50, 1, 500)) }; }
  adapterHealth(adapterId: string): JsonObject {
    const manifest = this.adapterGet(adapterId);
    const supported = (manifest.platforms as string[]).includes("any") || (manifest.platforms as string[]).includes(platform);
    const result = { adapter_id: adapterId, status: manifest.status === "active" && supported ? "healthy" : "unavailable", platform, checked_at: now() };
    this.store.save("adapter_health", adapterId, result);
    return result;
  }
  adapterConformance(adapterId: string): JsonObject {
    const manifest = this.adapterGet(adapterId);
    const checks = [Boolean(manifest.schema_version === 1), Boolean((manifest.capabilities as string[]).length || manifest.kind === "command"), Boolean((manifest.effects as string[]).length), Boolean(manifest.manifest_digest)];
    const result = { adapter_id: adapterId, passed: checks.every(Boolean), checks, checked_at: now() };
    this.store.save("adapter_conformance", adapterId, result);
    return result;
  }
  adapterQuarantine(adapterId: string, reason: string): JsonObject {
    const current = this.adapterGet(adapterId);
    return { manifest: this.store.save("adapter_manifest", adapterId, { ...current, status: "quarantined", quarantine_reason: required(reason, "reason") }) };
  }
  adapterRollback(adapterId: string): JsonObject {
    const current = this.adapterGet(adapterId);
    if (current.status !== "quarantined") throw new Error("adapter must be quarantined before rollback");
    return { manifest: this.store.save("adapter_manifest", adapterId, { ...current, status: "active", rollback_at: now() }) };
  }

  async adapterInstall(manifestPath: string, expectedIntegrity?: string): Promise<JsonObject> {
    const raw = await readFile(required(manifestPath, "manifest_path"), "utf8");
    const parsed = JSON.parse(raw) as Partial<AdapterManifest> & Pick<AdapterManifest, "adapter_id" | "version" | "kind">;
    const manifest = defineAdapterManifest(parsed);
    const actual = digest(manifest);
    if (expectedIntegrity && expectedIntegrity !== actual) throw new Error("adapter integrity mismatch");
    if (manifest.integrity && manifest.integrity !== actual) throw new Error("adapter integrity mismatch");
    if (!manifest.signature && !expectedIntegrity) throw new Error("adapter install requires a signature or expected integrity");
    if (manifest.dependencies && manifest.dependencies.install) throw new Error("runtime dependency installation is not allowed");
    return this.adapterRegister({ ...manifest, integrity: manifest.integrity ?? actual });
  }

  commandPlan(input: CommandRequest): JsonObject {
    const request = this.validateCommand(input);
    const id = `command_${randomUUID().replaceAll("-", "")}`;
    const plan = this.store.create("command_plan", id, { request, request_digest: digest(request), status: "planned", created_at: now() });
    return { plan, receipt_contract: "craft.command.receipt" };
  }
  async commandRun(input: CommandRequest & { plan_id?: string; run_id?: string }): Promise<JsonObject> {
    const request = this.validateCommand(input);
    const runId = input.run_id ?? `command_run_${randomUUID().replaceAll("-", "")}`;
    const run = this.store.create("command_run", runId, { request, request_digest: digest(request), status: "running", started_at: now() });
    const command = request.argv[0]; const args = request.argv.slice(1);
    const child = this.spawnProcess(command, args, { cwd: request.cwd, env: { ...process.env, ...request.env }, shell: request.shell === false ? false : request.shell ?? false, windowsHide: true });
    this.activeProcesses.set(runId, child);
    const limit = request.output_limit ?? 64 * 1024;
    let stdout = ""; let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => { stdout = `${stdout}${chunk.toString()}`.slice(0, limit); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(0, limit); });
    const outcome = await new Promise<JsonObject>((resolve) => {
      let settled = false;
      const finish = (status: CommandStatus, code: number | null, signal?: string) => { if (settled) return; settled = true; const receipt = { run_id: runId, status, exit_code: code, ...(signal ? { signal } : {}), stdout, stderr, stdout_digest: digest(stdout), stderr_digest: digest(stderr), adapter_id: request.adapter_id ?? "local.command", completed_at: now() }; this.activeProcesses.delete(runId); this.store.save("command_run", runId, { ...run, ...receipt }); this.store.appendEvent(`command:${runId}`, "command.completed", receipt); resolve({ run: this.store.get("command_run", runId), receipt }); };
      child.on("error", (error) => finish("failed", null, String(error.message).slice(0, 200)));
      child.on("close", (code, signal) => finish(signal === "SIGTERM" ? "cancelled" : code === 0 ? "completed" : "failed", code, signal ?? undefined));
      const timeout = request.timeout_ms ?? 120_000;
      const timer = setTimeout(() => { child.kill(); }, timeout); child.once("close", () => clearTimeout(timer));
    });
    return outcome;
  }
  commandObserve(runId: string): JsonObject { return this.store.get("command_run", required(runId, "run_id")); }
  commandCancel(runId: string): JsonObject {
    const id = required(runId, "run_id"); const process = this.activeProcesses.get(id); if (!process) { const saved = this.store.find("command_run", id); if (!saved) throw new Error(`Unknown command_run: ${id}`); if (saved.status === "running") return { run: this.store.save("command_run", id, { ...saved, cancel_requested: true, cancel_requested_at: now() }), requested: false, cross_process: true }; return { run: saved, idempotent: true }; }
    process.kill(); return { run: this.store.get("command_run", id), requested: true };
  }
  async commandRetry(runId: string): Promise<JsonObject> { const run = this.commandObserve(runId); return this.commandRun({ ...(run.request as CommandRequest), run_id: `retry_${randomUUID().replaceAll("-", "")}` }); }
  private validateCommand(input: CommandRequest): CommandRequest {
    const argv = list(input.argv, "argv", 1); const effect = input.effect ?? "read_only"; if (!EFFECTS.has(effect)) throw new Error("effect is unsupported");
    if (input.shell !== undefined && input.shell !== false && typeof input.shell !== "string") throw new Error("shell must be false or a shell path");
    if (input.shell && effect === "destructive" && !input.approval_ref) throw new Error("destructive shell command requires approval_ref");
    return { ...input, argv, effect, timeout_ms: integer(input.timeout_ms, "timeout_ms", 120_000, 100, 3_600_000), output_limit: integer(input.output_limit, "output_limit", 65_536, 256, 10_000_000), ...(input.cwd === undefined ? {} : { cwd: required(input.cwd, "cwd") }) };
  }

  contextManifestSave(input: JsonObject): JsonObject {
    const id = required(input.manifest_id ?? `context_${randomUUID().replaceAll("-", "")}`, "manifest_id");
    const manifest = { ...input, manifest_id: id, knowledge_refs: list(input.knowledge_refs ?? [], "knowledge_refs"), capability_refs: list(input.capability_refs ?? [], "capability_refs"), workflow_refs: list(input.workflow_refs ?? [], "workflow_refs"), excluded_refs: list(input.excluded_refs ?? [], "excluded_refs"), manifest_digest: digest(input), created_at: now() };
    const existing = this.store.find("context_manifest", id); if (existing) return { manifest: existing, idempotent: true }; return { manifest: this.store.create("context_manifest", id, manifest), idempotent: false };
  }
  capabilityProject(input: { candidates: JsonObject[]; required?: string[]; token_budget?: number }): JsonObject {
    const requiredCapabilities = input.required ?? []; const budget = input.token_budget ?? 1000; let spent = 0;
    const selected: JsonObject[] = []; const excluded: JsonObject[] = [];
    for (const candidate of input.candidates) { const cost = Number(candidate.token_cost ?? 100); const capability = String(candidate.capability ?? candidate.id ?? ""); if (requiredCapabilities.length && !requiredCapabilities.includes(capability)) { excluded.push({ ...candidate, reason: "not_required" }); continue; } if (spent + cost > budget) { excluded.push({ ...candidate, reason: "token_budget" }); continue; } selected.push(candidate); spent += cost; }
    return { selected, excluded, spent_tokens: spent, rationale: "required capabilities first, then token budget" };
  }

  durableStart(input: JsonObject): JsonObject { const id = required(input.run_id ?? `durable_${randomUUID().replaceAll("-", "")}`, "run_id"); const existing = this.store.find("durable_run", id); if (existing) return { run: existing, idempotent: true }; return { run: this.store.create("durable_run", id, { ...input, run_id: id, status: "queued", attempts: 0, lease_until: null, created_at: now() }), idempotent: false }; }
  durableTick(owner = "local", leaseSeconds = 30): JsonObject {
    const queued = this.store.list("durable_run", 1, (record) => ["queued", "running"].includes(String(record.status)) && (!record.lease_until || String(record.lease_until) < now())); const run = queued[0]; if (!run) return { claimed: false }; const claimed = this.store.save("durable_run", String(run.id), { ...run, status: "running", owner, attempts: Number(run.attempts ?? 0) + 1, lease_until: new Date(Date.now() + leaseSeconds * 1000).toISOString(), heartbeat_at: now() }); return { claimed: true, run: claimed };
  }
  durableComplete(runId: string, status: "completed" | "failed" | "cancelled", result?: JsonObject): JsonObject { const run = this.store.get("durable_run", required(runId, "run_id")); return { run: this.store.save("durable_run", runId, { ...run, status, lease_until: null, result: result ?? null, completed_at: now() }) }; }
  durableRecover(owner?: string): JsonObject { const runs = this.store.list("durable_run", 500, (record) => record.status === "running" && (!owner || record.owner === owner)); const recovered = runs.map((run) => this.store.save("durable_run", String(run.id), { ...run, status: "queued", lease_until: null, recovered_at: now() })); return { recovered: recovered.length, runs: recovered }; }

  trustRecord(input: { scope: string; passed: number; failed: number; evidence_refs?: string[] }): JsonObject { const passed = integer(input.passed, "passed", 0, 0, Number.MAX_SAFE_INTEGER); const failed = integer(input.failed, "failed", 0, 0, Number.MAX_SAFE_INTEGER); if (!passed && !failed) throw new Error("passed or failed is required"); const rate = passed / (passed + failed); const autonomy = rate >= .99 && passed >= 20 ? "automatic" : rate >= .9 ? "assisted" : "manual"; const id = `trust_${digest(input).slice(7, 23)}`; return { profile: this.store.save("trust_curve", id, { scope: required(input.scope, "scope"), passed, failed, reliability: rate, autonomy, evidence_refs: input.evidence_refs ?? [], updated_at: now() }) }; }
  modelRoute(input: { candidates: JsonObject[]; objective?: "quality" | "cost" | "latency"; budget?: number }): JsonObject { const objective = input.objective ?? "quality"; if (!input.candidates.length) throw new Error("candidates must not be empty"); const ranked = [...input.candidates].sort((a, b) => { const score = (item: JsonObject) => objective === "cost" ? -Number(item.cost ?? Number.MAX_SAFE_INTEGER) : objective === "latency" ? -Number(item.latency_ms ?? Number.MAX_SAFE_INTEGER) : Number(item.quality ?? 0); return score(b) - score(a); }); const selected = ranked.find((candidate) => input.budget === undefined || Number(candidate.cost ?? 0) <= input.budget) ?? ranked[0]; return { selected, ranked, rationale: `objective=${objective}` }; }

  deliveryGate(input: { artifacts: string[]; evidence: string[]; required_artifacts?: string[]; required_evidence?: string[] }): JsonObject { const artifacts = list(input.artifacts, "artifacts"); const evidence = list(input.evidence, "evidence"); const missingArtifacts = (input.required_artifacts ?? artifacts).filter((item) => !artifacts.includes(item)); const missingEvidence = (input.required_evidence ?? evidence).filter((item) => !evidence.includes(item)); const passed = !missingArtifacts.length && !missingEvidence.length; return { status: passed ? "passed" : "blocked", passed, missing_artifacts: missingArtifacts, missing_evidence: missingEvidence, gate: "delivery" }; }
  projectBundle(input: { project: JsonObject; tasks?: JsonObject[]; sessions?: JsonObject[]; trace?: JsonObject[]; artifacts?: JsonObject[] }): JsonObject { const bundle = { schema_version: 1, bundle_id: `bundle_${randomUUID().replaceAll("-", "")}`, exported_at: now(), project: input.project, tasks: input.tasks ?? [], sessions: input.sessions ?? [], trace: input.trace ?? [], artifacts: input.artifacts ?? [] }; return { bundle, digest: digest(bundle) }; }
  handoff(input: { context_manifest: JsonObject; host: JsonObject; task: JsonObject; budget?: JsonObject }): JsonObject { return { manifest_type: "craft.task.handoff", schema_version: 1, handoff_id: `handoff_${randomUUID().replaceAll("-", "")}`, context_manifest: input.context_manifest, host: input.host, task: input.task, budget: input.budget ?? {}, digest: digest(input) }; }
  evaluatorDefine(input: { evaluator_id: string; domain: string; criteria: string[] }): JsonObject { const id = required(input.evaluator_id, "evaluator_id"); return { evaluator: this.store.save("domain_evaluator", id, { evaluator_id: id, domain: required(input.domain, "domain"), criteria: list(input.criteria, "criteria", 1), status: "active" }) }; }
  evaluatorRun(input: { evaluator_id: string; observations: JsonObject }): JsonObject { const evaluator = this.store.get("domain_evaluator", required(input.evaluator_id, "evaluator_id")); const observations = obj(input.observations, "observations"); const missing = (evaluator.criteria as string[]).filter((criterion) => observations[criterion] === undefined); return { evaluator_id: evaluator.id, verdict: missing.length ? "inconclusive" : "passed", missing, observations }; }
}

export async function importOpenApiDocument(runtime: V01226Runtime, source: string | JsonObject): Promise<JsonObject> {
  const document = typeof source === "string" ? parse(source) as JsonObject : source;
  const paths = obj(document.paths ?? {}, "paths"); const operations: JsonObject[] = [];
  for (const [path, raw] of Object.entries(paths)) { const item = obj(raw, `paths.${path}`); for (const [method, operation] of Object.entries(item)) { if (!["get", "post", "put", "patch", "delete", "head"].includes(method)) continue; const op = obj(operation, `${path}.${method}`); const effect = ["get", "head"].includes(method) ? "read" : "external_write"; operations.push({ operation_id: String(op.operationId ?? `${method}_${path.replaceAll(/[^a-zA-Z0-9]+/g, "_")}`), method: method.toUpperCase(), path, effect, summary: op.summary ?? null }); } }
  if (!operations.length) throw new Error("OpenAPI document contains no operations");
  return runtime.adapterRegister({ adapter_id: String(document.info && typeof document.info === "object" && !Array.isArray(document.info) && (document.info as JsonObject).title ? `openapi.${String((document.info as JsonObject).title).toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}` : `openapi.${digest(document).slice(7, 19)}`), version: "1.0.0", kind: "openapi", platforms: ["any"], entry: "openapi", transport: "https", capabilities: operations.map((operation) => String(operation.operation_id)), effects: [...new Set(operations.map((operation) => String(operation.effect)))], metadata: { operations, openapi_version: document.openapi ?? document.swagger ?? "unknown" } });
}
