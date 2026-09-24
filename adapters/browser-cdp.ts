import { createHash } from "node:crypto";

export type BrowserOperation = "navigate" | "observe" | "fill" | "click" | "submit";
export type BrowserActionRequest = {
  request_id: string;
  operation: BrowserOperation;
  url?: string;
  selector?: string;
  value?: string;
  /** The desktop UI must set this after the person explicitly releases an L2 action. */
  human_release?: boolean;
};
export type CdpSession = { call(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>> };

const SELECTOR = /^[#.a-zA-Z][a-zA-Z0-9_\-.#>\[\]="':\s]{0,200}$/u;
const VISION = /(?:vision|vlm|screenshot|ocr|image|template|pixel|coordinate|bounding|cursor)/iu;
const MUTATION = new Set<BrowserOperation>(["fill", "click", "submit"]);

function digest(value: unknown): string { return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`; }
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}
function selector(value: unknown): string {
  const result = requiredString(value, "selector");
  if (!SELECTOR.test(result) || VISION.test(result)) throw new Error("selector must be a stable CSS selector; visual or coordinate location is forbidden");
  return result;
}
function escapeJsString(value: string): string { return JSON.stringify(value); }

/**
 * Adapter for an already-running Chromium browser with a user-enabled CDP port.
 *
 * It does not launch a browser, attach to arbitrary remote hosts, use screenshots, or accept
 * arbitrary JavaScript. Its five operations compile a bounded request into fixed DOM calls.
 * The caller must first have registered/adjudicated the action with BrowserDrivingKernel.
 */
export class BrowserCdpAdapter {
  readonly session: CdpSession;
  constructor(session: CdpSession) { this.session = session; }

  async execute(request: BrowserActionRequest): Promise<Record<string, unknown>> {
    const requestId = requiredString(request.request_id, "request_id");
    if (!Object.hasOwn({ navigate: true, observe: true, fill: true, click: true, submit: true }, request.operation)) throw new Error("operation is unsupported");
    if (MUTATION.has(request.operation) && request.human_release !== true) {
      return { request_id: requestId, result: "blocked", reason: "desktop_human_release_required", adapter: "browser_cdp" };
    }
    if (request.operation === "navigate") {
      const url = requiredString(request.url, "url");
      if (!/^https?:\/\/\S+$/iu.test(url)) throw new Error("url must be an http(s) URL");
      const result = await this.session.call("Page.navigate", { url });
      return this.#receipt(requestId, request.operation, result);
    }
    if (request.operation === "observe") {
      // This is deliberately a fixed, boolean-only inspection. It detects a handoff state
      // without collecting page text, form values, cookies, credentials, or a screenshot.
      const result = await this.#evaluate("(() => { const selector = 'input[type=\\\"password\\\"],input[autocomplete=\\\"one-time-code\\\"],iframe[src*=\\\"captcha\\\" i],[data-captcha],.g-recaptcha'; return { title: document.title, ready_state: document.readyState, url: location.href, login_takeover_required: Boolean(document.querySelector(selector)) }; })()");
      const value = (result.result as Record<string, unknown> | undefined)?.value as Record<string, unknown> | undefined;
      return { ...this.#receipt(requestId, request.operation, result), session_state: value?.login_takeover_required === true ? "user_login_takeover_required" : "ready", credential_content_stored: false, cookie_content_stored: false };
    }
    const target = selector(request.selector);
    if (request.operation === "fill") {
      const value = requiredString(request.value, "value");
      const result = await this.#evaluate(`(() => { const el = document.querySelector(${escapeJsString(target)}); if (!el || !(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error('editable control not found'); el.focus(); el.value = ${escapeJsString(value)}; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return { found: true, value_length: el.value.length }; })()`);
      return this.#receipt(requestId, request.operation, result);
    }
    if (request.operation === "click") {
      const result = await this.#evaluate(`(() => { const el = document.querySelector(${escapeJsString(target)}); if (!el || !(el instanceof HTMLElement)) throw new Error('clickable control not found'); if (el.matches(':disabled,[aria-disabled="true"]')) throw new Error('control is disabled'); el.click(); return { found: true }; })()`);
      return this.#receipt(requestId, request.operation, result);
    }
    const result = await this.#evaluate(`(() => { const el = document.querySelector(${escapeJsString(target)}); const form = el instanceof HTMLFormElement ? el : el && el.closest('form'); if (!(form instanceof HTMLFormElement)) throw new Error('form not found'); form.requestSubmit(); return { found: true }; })()`);
    return this.#receipt(requestId, request.operation, result);
  }

  async #evaluate(expression: string): Promise<Record<string, unknown>> {
    const response = await this.session.call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    const details = response.exceptionDetails as Record<string, unknown> | undefined;
    if (details) throw new Error(`browser operation failed: ${String(details.text ?? "script exception")}`);
    return response;
  }

  #receipt(requestId: string, operation: BrowserOperation, result: Record<string, unknown>): Record<string, unknown> {
    const value = result.result as Record<string, unknown> | undefined;
    return { request_id: requestId, operation, result: "succeeded", adapter: "browser_cdp", result_digest: digest(value?.value ?? null), raw_page_content_stored: false };
  }
}
