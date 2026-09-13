import { createHash } from "node:crypto";
import type { JsonObject } from "./store.ts";
function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim(); }
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
export interface A2AFetch { (input: string, init?: { method?: string; headers?: Record<string, string>; body?: string }): Promise<{ status: number; json(): Promise<unknown> }>; }
export class A2ATransportKernel {
  async dispatch(args: JsonObject, fetchImpl: A2AFetch = fetch as unknown as A2AFetch): Promise<JsonObject> {
    const endpoint = text(args.endpoint, "endpoint"); if (!endpoint.startsWith("https://")) throw new Error("A2A endpoint must use HTTPS"); const requestId = text(args.request_id, "request_id"); const envelope = { request_id: requestId, agent: text(args.agent, "agent"), operation: text(args.operation, "operation"), input_digest: text(args.input_digest, "input_digest"), execution_authority: false, trust: "untrusted_remote" };
    const response = await fetchImpl(endpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(envelope) }); if (response.status < 200 || response.status >= 300) throw new Error(`A2A transport HTTP ${response.status}`); const body = await response.json(); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("A2A response must be an object"); const result = body as JsonObject; const remoteId = text(result.remote_id, "remote_id"); const status = text(result.status, "status"); if (!(new Set(["accepted", "completed", "failed"]).has(status))) throw new Error("A2A response status is unsupported"); const resultDigest = result.result_digest === undefined ? null : text(result.result_digest, "result_digest"); return { request_id: requestId, remote_id: remoteId, status, result_digest: resultDigest, response_digest: digest({ remote_id: remoteId, status, result_digest: resultDigest }), raw_content: false };
  }

  async taskGet(args: JsonObject, fetchImpl: A2AFetch = fetch as unknown as A2AFetch): Promise<JsonObject> {
    const endpoint = text(args.endpoint, "endpoint"); if (!endpoint.startsWith("https://")) throw new Error("A2A endpoint must use HTTPS"); const taskId = text(args.task_id, "task_id");
    const response = await fetchImpl(`${endpoint.replace(/\/$/u, "")}/tasks/${encodeURIComponent(taskId)}`, { method: "GET", headers: { accept: "application/json" } }); if (response.status < 200 || response.status >= 300) throw new Error(`A2A task HTTP ${response.status}`);
    const body = await response.json(); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("A2A task response must be an object"); const value = body as JsonObject; const status = text(value.status, "status"); if (!new Set(["submitted", "working", "input-required", "completed", "failed", "canceled", "rejected"]).has(status)) throw new Error("A2A task status is unsupported"); return { task_id: taskId, status, artifact_refs: Array.isArray(value.artifact_refs) ? value.artifact_refs : [], raw_content: false, response_digest: digest(value) };
  }

  async taskCancel(args: JsonObject, fetchImpl: A2AFetch = fetch as unknown as A2AFetch): Promise<JsonObject> {
    const endpoint = text(args.endpoint, "endpoint"); if (!endpoint.startsWith("https://")) throw new Error("A2A endpoint must use HTTPS"); const taskId = text(args.task_id, "task_id");
    const response = await fetchImpl(`${endpoint.replace(/\/$/u, "")}/tasks/${encodeURIComponent(taskId)}:cancel`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ task_id: taskId, reason_digest: digest(args.reason ?? "user_requested"), execution_authority: false }) }); if (response.status < 200 || response.status >= 300) throw new Error(`A2A cancel HTTP ${response.status}`);
    const body = await response.json(); if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("A2A cancel response must be an object"); const value = body as JsonObject; return { task_id: taskId, status: text(value.status, "status"), canceled: true, raw_content: false, response_digest: digest(value) };
  }
}
