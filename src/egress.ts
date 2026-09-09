import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request, type RequestOptions } from "node:https";
import type { ClientRequest, IncomingMessage } from "node:http";
import { isIP } from "node:net";
import type { JsonObject } from "./store.ts";

export type EgressResponse = { status: number; headers: Record<string, string>; body: string; output_limited: boolean };
export type EgressResolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;
export type EgressTransport = (input: { url: URL; method: string; headers: Record<string, string>; body: string;
  address: string; family: number; timeout_ms: number; output_limit: number }) => Promise<EgressResponse>;

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); return value.trim();
}
function canonicalHeaders(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("headers must be an object");
  const entries = Object.entries(value as JsonObject).map(([rawName, rawValue]) => {
    const name = text(rawName, "header name").toLowerCase(); const headerValue = text(rawValue, `headers.${name}`);
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/u.test(name) || /^(authorization|cookie|proxy-authorization|x-api-key)$/u.test(name)) {
      throw new Error("Caller headers contain a forbidden or invalid name");
    }
    if (/\r|\n/u.test(headerValue)) throw new Error("Header values must not contain line breaks");
    return [name, headerValue] as const;
  });
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}
function body(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") throw new Error("body must be a string");
  if (Buffer.byteLength(value) > 1024 * 1024) throw new Error("body exceeds the 1 MiB request limit");
  return value;
}
export function egressRequestDigest(methodValue: unknown, urlValue: unknown, headersValue: unknown, bodyValue: unknown): string {
  const method = text(methodValue, "method").toUpperCase(); const target = new URL(text(urlValue, "url"));
  const headers = canonicalHeaders(headersValue); const requestBody = body(bodyValue);
  return `sha256:${createHash("sha256").update(JSON.stringify({ method, url: target.toString(), headers, body: requestBody })).digest("hex")}`;
}
export function isPrivateEgressAddress(address: string): boolean {
  const normalized = address.toLowerCase();
  if (isIP(normalized) === 4) {
    const parts = normalized.split(".").map(Number); const [a, b] = parts;
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (isIP(normalized) === 6) return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || /^fe[89ab]/u.test(normalized) || normalized.startsWith("ff") || normalized.startsWith("::ffff:");
  return true;
}
function redact(value: string, secret: string): string {
  const hidden = value.split(secret).join("[REDACTED]");
  return hidden.replace(/(api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]+/giu, "$1=[REDACTED]");
}

type LookupAll = (hostname: string, options: { all: true; verbatim: true }) => Promise<Array<{ address: string; family: number }>>;
export async function resolvePublic(hostname: string,
  resolver: LookupAll = lookup as LookupAll): Promise<Array<{ address: string; family: number }>> {
  const answers = await resolver(hostname, { all: true, verbatim: true });
  if (!answers.length || answers.some((answer) => isPrivateEgressAddress(answer.address))) throw new Error("Egress DNS resolution returned a private or invalid address");
  return answers;
}

type HttpsRequester = (url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
export function createHttpsTransport(requester: HttpsRequester = request): EgressTransport {
  return (input) => new Promise((resolveResult, reject) => {
  const outgoing = requester(input.url, { method: input.method, headers: input.headers, timeout: input.timeout_ms,
    lookup: (_hostname, _options, callback) => callback(null, input.address, input.family) }, (response) => {
    const chunks: Buffer[] = []; let size = 0; let limited = false;
    response.on("data", (chunk: Buffer) => { size += chunk.length;
      if (size <= input.output_limit) chunks.push(chunk); else { limited = true; response.destroy(); } });
    response.on("end", () => resolveResult({ status: response.statusCode ?? 0,
      headers: Object.fromEntries(Object.entries(response.headers).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : String(value ?? "")])),
      body: Buffer.concat(chunks).toString("utf8"), output_limited: limited }));
    response.on("close", () => { if (limited) resolveResult({ status: response.statusCode ?? 0, headers: {},
      body: Buffer.concat(chunks).toString("utf8"), output_limited: true }); });
  });
  outgoing.on("timeout", () => outgoing.destroy(new Error("Egress request timed out")));
  outgoing.on("error", reject); if (input.body) outgoing.write(input.body); outgoing.end();
  });
}
export class TrustedEgressBroker {
  readonly env: NodeJS.ProcessEnv; readonly resolver: EgressResolver; readonly transport?: EgressTransport; readonly requester: HttpsRequester;
  constructor(env: NodeJS.ProcessEnv = process.env, resolver: EgressResolver = resolvePublic,
    transport?: EgressTransport, requester: HttpsRequester = request) {
    this.env = env; this.resolver = resolver; this.transport = transport; this.requester = requester;
  }

  async execute(args: JsonObject & { secret_ref: string }): Promise<JsonObject> {
    const target = new URL(text(args.url, "url"));
    if (target.protocol !== "https:" || target.username || target.password) throw new Error("Egress target must be an HTTPS URL without credentials");
    const method = text(args.method, "method").toUpperCase();
    if (!new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]).has(method)) throw new Error("Unsupported egress method");
    const headers = canonicalHeaders(args.headers); const requestBody = body(args.body);
    if (text(args.request_digest, "request_digest") !== egressRequestDigest(method, target.toString(), headers, requestBody)) {
      throw new Error("Egress request digest mismatch");
    }
    const secretRef = text(args.secret_ref, "secret_ref"); const variable = secretRef.startsWith("env:") ? secretRef.slice(4) : "";
    const secret = variable ? this.env[variable] : undefined;
    if (!secret) throw new Error("Credential is unavailable to the trusted broker");
    const headerName = args.header_name === undefined ? "authorization" : text(args.header_name, "header_name").toLowerCase();
    if (!/^[a-z0-9-]+$/u.test(headerName)) throw new Error("Invalid credential header name");
    const prefix = args.prefix === undefined ? "Bearer " : String(args.prefix);
    const answers = await this.resolver(target.hostname); const selected = answers[0];
    if (!selected || answers.some((answer) => isPrivateEgressAddress(answer.address))) throw new Error("Egress target did not resolve exclusively to public addresses");
    const send = this.transport ?? createHttpsTransport(this.requester);
    const response = await send({ url: target, method, headers: { ...headers, [headerName]: `${prefix}${secret}` },
      body: requestBody, address: selected.address, family: selected.family,
      timeout_ms: Number(args.timeout_ms ?? 15_000), output_limit: Number(args.output_limit ?? 1024 * 1024) });
    if (response.status >= 300 && response.status < 400) throw new Error("Egress redirects are not followed");
    return { status: response.status, headers: Object.fromEntries(Object.entries(response.headers)
      .filter(([name]) => !/^(set-cookie|www-authenticate|proxy-authenticate)$/iu.test(name))
      .map(([name, value]) => [name, redact(value, secret)])), body: redact(response.body, secret),
      output_limited: response.output_limited, resolved_address_digest: createHash("sha256").update(selected.address).digest("hex") };
  }
}
