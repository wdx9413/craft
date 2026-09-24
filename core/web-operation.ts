import { createHash, randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";

function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return number;
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")}`; }
function list(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = value.map((item) => text(item, name));
  if (new Set(result).size !== result.length) throw new Error(`${name} must contain unique values`);
  return result;
}
function url(value: unknown): URL {
  const parsed = new URL(text(value, "url"));
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("url must use http or https");
  return parsed;
}

/** Safe web boundary: GET/HEAD observation in core; interactive actions stay in an adapter. */
export class WebOperationKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  async fetch(args: JsonObject, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<JsonObject> {
    const target = url(args.url); const allowedHosts = list(args.allowed_hosts, "allowed_hosts");
    if (allowedHosts.length && !allowedHosts.includes(target.hostname)) throw new Error("url host is not in allowed_hosts");
    const method = String(args.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new Error("core web fetch only permits GET or HEAD");
    const timeout = integer(args.timeout_ms, "timeout_ms", 15_000, 100, 120_000);
    const maxBytes = integer(args.max_bytes, "max_bytes", 512_000, 1, 5_000_000);
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
    let response: Response;
    try { response = await fetchImpl(target, { method, redirect: "manual", signal: controller.signal, headers: { accept: String(args.accept ?? "text/html,application/json;q=0.9,*/*;q=0.1") } }); }
    finally { clearTimeout(timer); }
    const raw = method === "HEAD" ? "" : await response.text();
    const body = raw.slice(0, maxBytes); const truncated = raw.length > maxBytes;
    const observation = { operation: "web_fetch", method, url: target.toString(), host: target.hostname, status: response.status,
      ok: response.ok, content_type: response.headers.get("content-type"), body, body_digest: digest(raw), bytes: raw.length, truncated,
      observed_at: new Date().toISOString(), raw_content_stored: false };
    const id = String(args.operation_id ?? `web_${randomUUID().replaceAll("-", "")}`);
    const existing = this.store.find("web_operation", id);
    if (existing) return { operation: existing, observation: { ...observation, body: "" }, idempotent: true };
    const operation = this.store.create("web_operation", id, { kind: "fetch", method, url: target.toString(), host: target.hostname,
      status: response.status, ok: response.ok, content_type: observation.content_type, body_digest: observation.body_digest,
      bytes: raw.length, truncated, status_state: response.ok ? "observed" : "failed", raw_content_stored: false });
    return { operation, observation, idempotent: false };
  }

  prepare(args: JsonObject): JsonObject {
    const target = url(args.url); const operation = text(args.operation ?? "navigate", "operation");
    if (!["navigate", "click", "fill", "submit"].includes(operation)) throw new Error("unsupported browser operation");
    const effect = operation === "navigate" ? "read_only" : "external_write";
    const id = String(args.operation_id ?? `browser_${randomUUID().replaceAll("-", "")}`);
    const contract = { kind: "browser", operation, url: target.toString(), host: target.hostname, effect,
      task_id: text(args.task_id, "task_id"), workspace: text(args.workspace, "workspace"),
      approval_ref: args.approval_ref === undefined ? null : text(args.approval_ref, "approval_ref"),
      input_digest: text(args.input_digest, "input_digest"), adapter_required: true, execution_authority: false };
    const contractDigest = digest(contract); const existing = this.store.find("web_operation", id);
    if (existing) { if (existing.contract_digest !== contractDigest) throw new Error("browser operation idempotency conflict"); return { operation: existing, idempotent: true }; }
    return { operation: this.store.create("web_operation", id, { ...contract, contract_digest: contractDigest, status: "prepared" }), idempotent: false };
  }

  complete(args: JsonObject): JsonObject {
    const operation = this.store.get("web_operation", text(args.operation_id, "operation_id"));
    if (operation.kind !== "browser") throw new Error("only browser operations can be completed by an adapter");
    if (operation.status === "completed") return { operation, idempotent: true };
    const verdict = text(args.verdict, "verdict");
    if (!["passed", "failed", "blocked"].includes(verdict)) throw new Error("unsupported browser operation verdict");
    const receipt = this.store.create("web_operation_receipt", `receipt_${operation.id}`, { operation_id: operation.id, adapter_id: text(args.adapter_id, "adapter_id"), verdict, result_digest: text(args.result_digest, "result_digest"), observed: true });
    const saved = this.store.save("web_operation", String(operation.id), { ...operation, status: verdict === "passed" ? "completed" : verdict, receipt_id: receipt.id });
    return { operation: saved, receipt, idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { operation: this.store.get("web_operation", text(args.operation_id, "operation_id")) }; }
}
