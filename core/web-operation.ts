import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest, type ClientRequest, type IncomingMessage, type RequestOptions } from "node:http";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { request as httpsRequest } from "node:https";
import { isPrivateEgressAddress, resolvePublic } from "./egress.ts";
import { CraftStore, type JsonObject } from "./infrastructure/store.ts";
import { text } from "./validation.ts";

const DEFAULT_ACCEPT = "text/html,application/xhtml+xml,text/plain,application/json,application/ld+json,application/xml,text/xml";
const READABLE_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain", "application/json", "application/ld+json", "application/xml", "text/xml"]);
const CREDENTIAL_QUERY_KEY = /^(?:api[_-]?key|auth|authorization|cookie|password|secret|session|(?:(?:access|refresh|auth)[_-]?)?token)$/iu;
type WebAddress = { address: string; family: number };
type WebResolver = (hostname: string) => Promise<WebAddress[]>;
type WebRequestFactory = (target: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => ClientRequest;
type WebRequestFactories = Record<"http" | "https", WebRequestFactory>;
const DEFAULT_WEB_REQUEST_FACTORIES: WebRequestFactories = { http: httpRequest, https: httpsRequest };

function integer(value: unknown, name: string, fallback: number, minimum: number, maximum: number): number {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return number;
}
function digest(value: unknown): string { return `sha256:${createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex")}`; }
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
  if (parsed.username || parsed.password) throw new Error("url must not include credentials");
  if ([...parsed.searchParams.keys()].some((key) => CREDENTIAL_QUERY_KEY.test(key))) {
    throw new Error("url must not include credential parameters");
  }
  parsed.hash = "";
  return parsed;
}

async function readBounded(response: Response, maxBytes: number, signal: AbortSignal): Promise<{ body: string; bytes: number; digest: string; truncated: boolean }> {
  if (!response.body) return { body: "", bytes: 0, digest: digest(""), truncated: false };
  const reader = response.body.getReader(); const chunks: Buffer[] = []; let bytes = 0; let truncated = false;
  try {
    while (true) {
      let abortListener: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(new Error("web fetch timed out while reading the response"));
        signal.addEventListener("abort", abortListener, { once: true });
      });
      let item: ReadableStreamReadResult<Uint8Array>;
      try { item = await Promise.race([reader.read(), aborted]); }
      finally { if (abortListener) signal.removeEventListener("abort", abortListener); }
      if (item.done) break;
      const chunk = Buffer.from(item.value); const remaining = maxBytes - bytes;
      const bounded = chunk.subarray(0, remaining);
      if (bounded.length) chunks.push(bounded);
      bytes += bounded.length;
      if (bounded.length < chunk.length) {
        truncated = true;
        await reader.cancel();
        break;
      }
      if (bytes === maxBytes) {
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength === maxBytes) break;
        let abortListener: (() => void) | undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
          abortListener = () => reject(new Error("web fetch timed out while reading the response"));
          signal.addEventListener("abort", abortListener, { once: true });
        });
        let next: ReadableStreamReadResult<Uint8Array>;
        try { next = await Promise.race([reader.read(), aborted]); }
        finally { if (abortListener) signal.removeEventListener("abort", abortListener); }
        truncated = !next.done;
        if (truncated) await reader.cancel();
        break;
      }
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const content = Buffer.concat(chunks);
  return { body: content.toString("utf8"), bytes, digest: digest(content), truncated };
}

function readablePage(response: Response): boolean {
  const type = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
  const disposition = (response.headers.get("content-disposition") ?? "").toLowerCase();
  return !/\battachment\b/u.test(disposition) && READABLE_TYPES.has(type);
}

function sourceTitle(contentType: string | null, body: string, target: URL): string {
  let title = "";
  if ((contentType ?? "").toLowerCase().startsWith("text/html")) {
    const match = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/iu.exec(body);
    if (match) title = match[1]!.replace(/<[^>]*>/gu, " ").replace(/&amp;/giu, "&").replace(/&lt;/giu, "<").replace(/&gt;/giu, ">").replace(/&quot;/giu, "\"").replace(/&#39;/gu, "'").replace(/\s+/gu, " ").trim();
  }
  return (title || `${target.hostname}${target.pathname}`).slice(0, 240);
}

function htmlText(value: string): string {
  return value.replace(/<[^>]*>/gu, " ").replace(/&amp;/giu, "&").replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">").replace(/&quot;/giu, "\"").replace(/&#39;/giu, "'")
    .replace(/&#(\d+);/gu, (_match, code: string) => String.fromCodePoint(Math.min(0x10ffff, Number(code))))
    .replace(/&#x([0-9a-f]+);/giu, (_match, code: string) => String.fromCodePoint(Math.min(0x10ffff, Number.parseInt(code, 16))))
    .replace(/\s+/gu, " ").trim();
}

function searchItems(body: string, maxResults: number): JsonObject[] {
  const anchors = [...body.matchAll(/<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult__a\b[^"']*["'])[^>]*>/giu)];
  const items: JsonObject[] = []; const seen = new Set<string>();
  for (let index = 0; index < anchors.length && items.length < maxResults; index += 1) {
    const anchor = anchors[index]!; const start = anchor.index!; const end = anchors[index + 1]?.index ?? body.length;
    const tag = anchor[0]; const href = /\bhref\s*=\s*(["'])(.*?)\1/iu.exec(tag)?.[2];
    const closingAnchor = body.toLowerCase().indexOf("</a>", start + tag.length);
    const title = closingAnchor < 0 || closingAnchor >= end ? "" : htmlText(body.slice(start + tag.length, closingAnchor));
    if (!href || !title) continue;
    let target: URL;
    try {
      target = new URL(htmlText(href), "https://html.duckduckgo.com");
      if (target.hostname === "html.duckduckgo.com" && target.pathname === "/l/") {
        const destination = target.searchParams.get("uddg"); if (!destination) continue;
        target = new URL(destination);
      }
      if ((target.protocol !== "https:" && target.protocol !== "http:") || target.username || target.password
        || [...target.searchParams.keys()].some((key) => CREDENTIAL_QUERY_KEY.test(key))) continue;
    } catch { continue; }
    target.hash = ""; const normalized = target.toString(); if (seen.has(normalized)) continue; seen.add(normalized);
    const segment = body.slice(start, end);
    const snippetTag = /<a\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'])[^>]*>([\s\S]*?)<\/a>/iu.exec(segment)
      ?? /<(?:div|span)\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bresult__snippet\b[^"']*["'])[^>]*>([\s\S]*?)<\/(?:div|span)>/iu.exec(segment);
    const snippet = htmlText(snippetTag?.[1] ?? "").slice(0, 500);
    items.push({ title: title.slice(0, 240), url: normalized, snippet, trust: "unverified_discovery", verified_content: false });
  }
  return items;
}

function markdownText(value: string): string {
  return value.replace(/\s+/gu, " ").trim().replace(/([\\`*_{}\[\]<>|])/gu, "\\$1");
}

function publicAddress(address: string, family: number): boolean {
  if (isIP(address) !== family || isPrivateEgressAddress(address)) return false;
  if (family === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 192 && b === 0 && c === 0) && !(a === 192 && b === 0 && c === 2)
      && !(a === 192 && b === 88 && c === 99) && !(a === 198 && b === 18)
      && !(a === 198 && b === 19) && !(a === 198 && b === 51 && c === 100)
      && !(a === 203 && b === 0 && c === 113);
  }
  const first = parseInt(address.split(":", 1)[0] || "0", 16);
  const publicIpv6 = family === 6 && first >= 0x2000 && first <= 0x3fff && !address.toLowerCase().startsWith("2001:db8:");
  return publicIpv6;
}

async function resolvePublicHost(hostnameValue: string, resolver: WebResolver): Promise<WebAddress[]> {
  const hostname = hostnameValue.replace(/^\[|\]$/gu, "").toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) throw new Error("url host is not a public address");
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await resolver(hostname);
  if (!addresses.length || addresses.some((item) => !publicAddress(item.address, item.family))) {
    throw new Error("web fetch resolution returned a private or invalid public address");
  }
  return addresses;
}

function requestPinned(target: URL, method: string, accept: string, address: WebAddress, signal: AbortSignal, timeout: number, requestFactories: WebRequestFactories): Promise<Response> {
  return new Promise((resolveResponse, reject) => {
    const requester = target.protocol === "https:" ? requestFactories.https : requestFactories.http;
    const request = requester(target, { method, headers: { accept }, signal, timeout,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family) }, (response) => {
      const headers = new Headers();
      for (const name of ["content-type", "content-disposition", "location", "content-length"]) {
        const value = response.headers[name];
        if (typeof value === "string") headers.set(name, value);
      }
      const status = response.statusCode ?? 502;
      const body = method === "HEAD" || status === 204 || status === 304 ? null : Readable.toWeb(response) as ReadableStream<Uint8Array>;
      resolveResponse(new Response(body, { status, headers }));
    });
    request.on("timeout", () => request.destroy(new Error("web fetch timed out")));
    request.on("error", reject);
    request.end();
  });
}

/** Safe web boundary: GET/HEAD observation in core; interactive actions stay in an adapter. */
export class WebOperationKernel {
  readonly store: CraftStore;
  readonly requestFactories: WebRequestFactories;
  constructor(store: CraftStore, requestFactories: WebRequestFactories = DEFAULT_WEB_REQUEST_FACTORIES) { this.store = store; this.requestFactories = requestFactories; }

  async fetch(args: JsonObject, fetchImpl?: typeof globalThis.fetch, resolver: WebResolver = resolvePublic): Promise<JsonObject> {
    const target = url(args.url); const allowedHosts = list(args.allowed_hosts, "allowed_hosts");
    if (allowedHosts.length && !allowedHosts.includes(target.hostname)) throw new Error("url host is not in allowed_hosts");
    const taskId = text(args.task_id, "task_id");
    const method = String(args.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new Error("core web fetch only permits GET or HEAD");
    const timeout = integer(args.timeout_ms, "timeout_ms", 15_000, 100, 120_000);
    const maxBytes = integer(args.max_bytes, "max_bytes", 512_000, 1, 5_000_000);
    const accept = args.accept === undefined ? DEFAULT_ACCEPT : text(args.accept, "accept");
    if (accept.length > 256 || /[\r\n]/u.test(accept)) throw new Error("accept is invalid");
    const id = String(args.operation_id ?? `web_${randomUUID().replaceAll("-", "")}`);
    const requestDigest = digest({ task_id: taskId, method, url: target.toString(), allowed_hosts: allowedHosts, timeout_ms: timeout, max_bytes: maxBytes, accept });
    const existing = this.store.find("web_operation", id);
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new Error("web operation idempotency conflict");
      const source = this.store.find("web_source", String(existing.source_id ?? ""));
      const evidence = existing.evidence_id ? this.store.find("evidence", String(existing.evidence_id)) : null;
      return { operation: existing, observation: { operation: "web_fetch", method, url: target.toString(), host: target.hostname,
        status: existing.status, ok: existing.ok, content_type: existing.content_type, body: "", body_digest: existing.body_digest,
        bytes: existing.bytes, truncated: existing.truncated, observed_at: existing.observed_at, raw_content_stored: false,
        source_id: existing.source_id }, source, evidence, idempotent: true };
    }
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeout);
    let timeoutListener: (() => void) | undefined;
    const timedOut = new Promise<never>((_resolve, reject) => {
      timeoutListener = () => reject(new Error("web fetch timed out"));
      controller.signal.addEventListener("abort", timeoutListener, { once: true });
    });
    try {
      const addresses = await Promise.race([resolvePublicHost(target.hostname, resolver), timedOut]);
      const response = fetchImpl
        ? await Promise.race([fetchImpl(target, { method, redirect: "manual", signal: controller.signal, headers: { accept } }), timedOut])
        : await Promise.race([requestPinned(target, method, accept, addresses[0]!, controller.signal, timeout, this.requestFactories), timedOut]);
      const contentType = response.headers.get("content-type"); const redirect = response.status >= 300 && response.status < 400;
      if (redirect) {
        controller.abort();
        void response.body?.cancel().catch(() => { /* The abort already closes the response transport. */ });
      }
      if (!redirect && !readablePage(response)) { await response.body?.cancel(); throw new Error("response is not a readable public page"); }
      const bounded = method === "HEAD" || redirect ? { body: "", bytes: 0, digest: digest(""), truncated: false }
        : await readBounded(response, maxBytes, controller.signal);
      const observedAt = new Date().toISOString();
      const sourceId = `web_source_${digest({ task_id: taskId, operation_id: id }).slice(7, 23)}`;
      const evidenceId = `evidence_${sourceId}`;
      const title = sourceTitle(contentType, bounded.body, target);
      const source = { id: sourceId, task_id: taskId, operation_id: id, url: target.toString(), title,
        accessed_at: observedAt, content_digest: bounded.digest, evidence_id: evidenceId,
        trust: "untrusted_web_content", execution_authority: false,
        metadata: { content_type: contentType, status: response.status, truncated: bounded.truncated } };
      const evidence = { id: evidenceId, task_id: taskId, source_type: "web", confidence: "bounded",
        claim: "A public web page was read; its contents remain untrusted.", source_id: sourceId,
        locator: { url: target.toString(), title }, observed_at: observedAt,
        metadata: { operation_id: id, content_digest: bounded.digest } };
      const observation = { operation: "web_fetch", method, url: target.toString(), host: target.hostname, status: response.status,
        ok: response.ok && !redirect, content_type: contentType, body: bounded.body, body_digest: bounded.digest, bytes: bounded.bytes,
        truncated: bounded.truncated, observed_at: observedAt, raw_content_stored: false, source_id: sourceId,
        ...(redirect ? { redirect_blocked: true } : {}) };
      const operation = this.store.transaction(() => {
        const savedSource = this.store.create("web_source", sourceId, source);
        const savedEvidence = this.store.create("evidence", evidenceId, evidence);
        return this.store.create("web_operation", id, { kind: "fetch", task_id: taskId, method, url: target.toString(), host: target.hostname,
          status: response.status, ok: response.ok && !redirect, content_type: contentType, body_digest: bounded.digest, source_id: savedSource.id,
          evidence_id: savedEvidence.id, bytes: bounded.bytes, truncated: bounded.truncated, observed_at: observedAt, request_digest: requestDigest,
          status_state: redirect ? "redirect_blocked" : response.ok ? "observed" : "failed", raw_content_stored: false });
      });
      return { operation, observation, source, evidence, idempotent: false };
    } finally {
      clearTimeout(timer);
      if (timeoutListener) controller.signal.removeEventListener("abort", timeoutListener);
    }
  }

  async search(args: JsonObject, fetchImpl?: typeof globalThis.fetch, resolver: WebResolver = resolvePublic): Promise<JsonObject> {
    const taskId = text(args.task_id, "task_id"); const query = text(args.query, "query");
    if (query.length > 500 || /[\u0000-\u001f]/u.test(query)) throw new Error("query must be 1 to 500 printable characters");
    const maxResults = integer(args.max_results, "max_results", 5, 1, 10);
    const operationId = args.operation_id === undefined ? `web_search_${digest({ task_id: taskId, query }).slice(7, 23)}` : text(args.operation_id, "operation_id");
    const requestDigest = digest({ task_id: taskId, query, max_results: maxResults });
    const resultId = `web_search_result_${digest({ task_id: taskId, operation_id: operationId }).slice(7, 23)}`;
    const prior = this.store.find("web_search_result", resultId);
    if (prior) {
      if (prior.request_digest !== requestDigest) throw new Error("web search idempotency conflict");
      return { search: prior, source: this.store.find("web_source", String(prior.source_id)), evidence: this.store.find("evidence", String(prior.evidence_id)), idempotent: true };
    }
    const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const fetched = await this.fetch({ task_id: taskId, operation_id: operationId, url: searchUrl,
      allowed_hosts: ["html.duckduckgo.com"], max_bytes: 512_000, timeout_ms: 15_000 }, fetchImpl, resolver);
    const observation = fetched.observation as JsonObject;
    const source = fetched.source as JsonObject;
    if (fetched.idempotent === true) {
      const incomplete = { id: resultId, task_id: taskId, operation_id: operationId, query, request_digest: requestDigest,
        source_id: source.id, evidence_id: null, observed_at: observation.observed_at, status: "content_unavailable_after_interruption", items: [] };
      return { search: incomplete, source, evidence: null, idempotent: true, recoverable: false };
    }
    if (observation.ok !== true) throw new Error(`public web search failed with HTTP ${String(observation.status)}`);
    const items = searchItems(observation.body as string, maxResults);
    const evidenceId = `evidence_web_search_${digest({ task_id: taskId, operation_id: operationId }).slice(7, 23)}`;
    const evidenceRecord = { task_id: taskId, source_type: "web_search", confidence: "unverified",
      claim: "Search result snippets are discovery leads; they do not verify the linked page content.", source_id: source.id,
      locator: { url: source.url, title: source.title }, observed_at: observation.observed_at,
      metadata: { operation_id: operationId, content_digest: source.content_digest } };
    const { search, evidence } = this.store.transaction(() => {
      const savedEvidence = this.store.create("evidence", evidenceId, evidenceRecord);
      const savedSearch = this.store.create("web_search_result", resultId, { task_id: taskId, operation_id: operationId, query,
        request_digest: requestDigest, source_id: source.id, evidence_id: savedEvidence.id, observed_at: observation.observed_at,
        status: items.length ? "results" : "no_results", items });
      return { search: savedSearch, evidence: savedEvidence };
    });
    return { search, source, evidence, idempotent: false };
  }

  renderReport(args: JsonObject): JsonObject {
    const taskId = text(args.task_id, "task_id"); const title = text(args.title, "title");
    const sources = new Map<string, JsonObject>(); const usedEvidence: string[] = [];
    type Category = "source_backed_claims" | "source_conflicts" | "promotions_and_conditions" | "missing_or_unverifiable" | "inferences";
    const categories: Array<{ key: Category; heading: string; requiresEvidence: boolean; allowsSearchEvidence: boolean; requiresReason: boolean }> = [
      { key: "source_backed_claims", heading: "Findings with sources (not independently verified by Craft)", requiresEvidence: true, allowsSearchEvidence: false, requiresReason: false },
      { key: "source_conflicts", heading: "Source conflicts", requiresEvidence: true, allowsSearchEvidence: false, requiresReason: false },
      { key: "promotions_and_conditions", heading: "Promotions and conditions", requiresEvidence: true, allowsSearchEvidence: false, requiresReason: false },
      { key: "missing_or_unverifiable", heading: "Missing or unverifiable information", requiresEvidence: false, allowsSearchEvidence: true, requiresReason: true },
      { key: "inferences", heading: "Inferences", requiresEvidence: false, allowsSearchEvidence: false, requiresReason: true },
    ];
    const normalized: Record<Category, JsonObject[]> = {
      source_backed_claims: [], source_conflicts: [], promotions_and_conditions: [], missing_or_unverifiable: [], inferences: [],
    };
    for (const category of categories) {
      const rawItems = args[category.key] ?? (category.key === "source_backed_claims" ? args.findings : undefined) ?? [];
      if (!Array.isArray(rawItems)) throw new Error(`${category.key} must be an array`);
      normalized[category.key] = rawItems as JsonObject[];
    }
    const totalItems = categories.reduce((sum, category) => sum + normalized[category.key].length, 0);
    if (!totalItems || totalItems > 50) throw new Error("report must contain between 1 and 50 classified items");
    const cite = (evidenceId: string, category: typeof categories[number]): number => {
      const evidence = this.store.get("evidence", evidenceId);
      if (evidence.task_id !== taskId) throw new Error("web Evidence belongs to a different task");
      if (typeof evidence.source_id !== "string" || !["web", "web_search"].includes(String(evidence.source_type))) throw new Error("report Evidence is not from a web Source");
      if (category.requiresEvidence && (evidence.confidence !== "bounded" || evidence.source_type !== "web")) throw new Error("report findings require bounded web Evidence");
      if (!category.allowsSearchEvidence && evidence.source_type === "web_search") throw new Error("unverified search Evidence cannot support this section; fetch the result page first");
      const source = this.store.get("web_source", evidence.source_id);
      if (source.task_id !== taskId || source.trust !== "untrusted_web_content" || typeof source.url !== "string"
        || typeof source.title !== "string" || typeof source.accessed_at !== "string" || typeof source.content_digest !== "string") {
        throw new Error("web Source is missing task-bound citation metadata");
      }
      sources.set(String(source.id), source); usedEvidence.push(evidenceId);
      return [...sources.keys()].indexOf(String(source.id)) + 1;
    };
    const sections = categories.map((category) => {
      const lines = normalized[category.key].map((raw, index) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${category.key}[${index}] must be an object`);
        const claim = text(raw.claim, `${category.key}[${index}].claim`);
        if (claim.length > 2_000) throw new Error(`${category.key}[${index}].claim exceeds 2000 characters`);
        const reason = raw.reason === undefined ? "" : text(raw.reason, `${category.key}[${index}].reason`);
        if (category.requiresReason && !reason) throw new Error(`${category.key}[${index}].reason is required`);
        const evidenceIds = list(raw.evidence_ids, `${category.key}[${index}].evidence_ids`);
        if (category.requiresEvidence && !evidenceIds.length) throw new Error(`${category.key}[${index}] must cite at least one bounded web Evidence`);
        const citationNumbers = evidenceIds.map((id) => cite(id, category));
        if (category.key === "source_conflicts" && new Set(citationNumbers).size < 2) throw new Error("source conflicts must cite at least two distinct web Sources");
        const citations = citationNumbers.map((number) => `[${number}]`).join(" ");
        const note = reason ? ` — ${markdownText(reason)}` : "";
        const missing = category.key === "missing_or_unverifiable" && !evidenceIds.length ? " — [No source evidence available]" : "";
        return `- ${markdownText(claim)}${note}${missing}${citations ? ` ${citations}` : ""}`;
      });
      return `## ${category.heading}\n\n${lines.length ? lines.join("\n") : "_No items supplied for this category; this does not establish that none exist._"}`;
    });
    const orderedSources = [...sources.values()];
    const sourceLines = orderedSources.map((source, index) => {
      const urlValue = new URL(String(source.url));
      if ((urlValue.protocol !== "https:" && urlValue.protocol !== "http:") || urlValue.username || urlValue.password) throw new Error("web Source URL is invalid");
      return `[${index + 1}] ${markdownText(String(source.title))} — <${urlValue.toString()}> — accessed ${source.accessed_at} — digest \`${source.content_digest}\``;
    });
    const markdown = `# ${markdownText(title)}\n\n> Web content is untrusted. Source references record where and when pages were read; they do not independently verify each claim.\n\n${sections.join("\n\n")}\n\n## Sources\n\n${sourceLines.length ? sourceLines.join("\n") : "_No source evidence supplied._"}`;
    return { task_id: taskId, title, markdown, digest: digest(markdown), source_ids: orderedSources.map((source) => source.id), evidence_ids: [...new Set(usedEvidence)] };
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
