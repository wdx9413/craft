import { randomUUID } from "node:crypto";
import { stableDigest } from "../core/digest.ts";
import type { ControlAction, ControlAdapter, ControlObservation } from "../capability/control-session.ts";
import type { CdpSession } from "./browser-cdp.ts";

// Runs only in a named isolated world. No caller-supplied JavaScript or CSS selector.
// No input values, page body, credentials or cookies are returned to the Host.
const SNAPSHOT = `(() => {
  const state = globalThis.__craftControl ??= { ids: new WeakMap(), next: 0, epoch: 0,
    observer: new MutationObserver(() => { state.epoch++; }) };
  state.observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  if (state.observer.takeRecords().length) state.epoch++;
  const elements = Array.from(document.querySelectorAll('a,button,input,textarea,select,form,[role="button"]'));
  if (elements.length > 100) throw new Error('observation capacity exceeded');
  // DOM property writes need not emit mutations. Keep their comparison material
  // inside this isolated world; only an epoch leaves it, never values or hashes
  // from which a low-entropy secret could be recovered.
  const properties = JSON.stringify(elements.map(el => [el.value, el.checked, el.indeterminate,
    el.readOnly, el.selectedIndex, el.options ? Array.from(el.options, option => option.selected) : null]));
  if (state.properties !== properties) { state.properties = properties; state.epoch++; }
  state.nodes = new Map();
  const nodes = elements.map(el => {
    if (!state.ids.has(el)) state.ids.set(el, ++state.next);
    const ref = String(state.ids.get(el)); state.nodes.set(ref, el);
    const rect = el.getBoundingClientRect();
    return { ref, tag: el.tagName, type: el.getAttribute('type'), name: el.getAttribute('name'),
      label: (el.getAttribute('aria-label') || '').slice(0, 200),
      destination: el.getAttribute('href') || el.getAttribute('action') || '',
      disabled: el.matches(':disabled,[aria-disabled="true"]'),
      rect: [rect.x, rect.y, rect.width, rect.height] };
  });
  return { origin: location.origin, url: location.href, ready: document.readyState, epoch: state.epoch, nodes,
    takeover: Boolean(document.querySelector('input[type="password"],input[autocomplete="one-time-code"],iframe[src*="captcha" i],[data-captcha],.g-recaptcha')) };
})()`;

type Snapshot = { origin: string; url: string; ready: string; epoch: number; takeover: boolean; nodes: { ref: string; tag: string; name: string | null; label: string }[] };

/**
 * Adapter only: the owning Control Host must authorize and approve every action.
 * Its CDP transport must come from pinned loopback discovery, never a model argument.
 * Isolated JavaScript protects bookkeeping from page scripts, not a security sandbox.
 */
export function createBrowserControlAdapter(session: CdpSession & { close(): void }, targetId: string, allowedOrigins: string[]) {
  if (!/^[a-zA-Z0-9_-]{1,200}$/u.test(targetId) || !allowedOrigins.length) throw new Error("Pinned browser target and origins required");
  const origins = [...allowedOrigins];
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !["http:", "https:"].includes(url.protocol)) throw new Error("Canonical http(s) origins required");
  }
  const worldName = `craft-control-${randomUUID()}`;
  let closed = false;
  let snapshot: { context: number; data: Snapshot; raw: string } | undefined;
  function close(): void { closed = true; snapshot = undefined; session.close(); }
  async function bounded<T>(target: string, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    if (closed || signal.aborted || target !== targetId) throw new Error("Browser target unavailable or cancelled");
    const abort = () => close();
    signal.addEventListener("abort", abort, { once: true });
    let result: T | undefined;
    let failed = false;
    try {
      result = await operation();
      if (closed || signal.aborted) throw new Error("Browser operation cancelled");
    } catch {
      snapshot = undefined;
      failed = true;
    } finally { signal.removeEventListener("abort", abort); }
    if (failed) throw new Error("Browser operation failed; reconcile any uncertain effect");
    return result as T;
  }
  async function context(): Promise<number> {
    const info = (await session.call("Target.getTargetInfo")).targetInfo as { targetId: string; type: string } | undefined;
    if (!info || info.targetId !== targetId || info.type !== "page") throw new Error("Browser target changed");
    const tree = (await session.call("Page.getFrameTree")).frameTree as { frame: { id: string } } | undefined;
    if (!tree?.frame?.id) throw new Error("Browser frame unavailable");
    const world = await session.call("Page.createIsolatedWorld", { frameId: tree.frame.id, worldName, grantUniveralAccess: false });
    if (!Number.isInteger(world.executionContextId) || Number(world.executionContextId) < 1) throw new Error("Browser isolated context unavailable");
    return Number(world.executionContextId);
  }
  async function evaluate(contextId: number, expression: string): Promise<unknown> {
    const response = await session.call("Runtime.evaluate", { contextId, expression, returnByValue: true, awaitPromise: true, userGesture: true });
    const result = response.result as { value?: unknown } | undefined;
    if (response.exceptionDetails || !result || !Object.hasOwn(result, "value")) throw new Error("Browser script failed");
    return result.value;
  }
  const adapter: ControlAdapter = {
    observe(target, signal) {
      return bounded(target, signal, async () => {
        const contextId = await context();
        const data = await evaluate(contextId, SNAPSHOT) as Snapshot;
        if (!data || !origins.includes(data.origin) || typeof data.takeover !== "boolean" || !Array.isArray(data.nodes)
          || data.nodes.length > 100 || data.nodes.some(node => !node || !/^\d+$/u.test(node.ref))
          || new Set(data.nodes.map(node => node.ref)).size !== data.nodes.length) throw new Error("Invalid or unauthorized browser observation");
        snapshot = { context: contextId, data, raw: JSON.stringify(data) };
        const observation: ControlObservation = { identity: `browser:${targetId}`, origin: data.origin,
          state_digest: stableDigest({ context: contextId, data }), element_refs: data.nodes.map(node => `${contextId}:${node.ref}`), user_takeover: data.takeover };
        return observation;
      });
    },
    execute(target, action, signal) {
      return bounded(target, signal, async () => {
        const before = snapshot; snapshot = undefined; // single use, including failed dispatch
        if (!before || before.data.takeover || Object.keys(action).some(key => !["operation", "element_ref", "value", "url"].includes(key))) throw new Error("Browser observation or action invalid");
        if (await context() !== before.context) throw new Error("Browser document changed");
        if (action.operation === "navigate") {
          const url = new URL(String(action.url));
          if (!origins.includes(url.origin) || !["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Browser navigation outside authorized origins");
          if (JSON.stringify(await evaluate(before.context, SNAPSHOT)) !== before.raw) throw new Error("Browser observation changed");
          const result = await session.call("Page.navigate", { url: url.href });
          if (result.errorText || !result.frameId) throw new Error("Browser navigation failed");
          return { receipt_digest: stableDigest({ operation: action.operation, result }) };
        }
        if (!["fill", "click", "submit"].includes(action.operation) || !before.data.nodes.some(node => action.element_ref === `${before.context}:${node.ref}`)
          || (action.operation === "fill" && (typeof action.value !== "string" || action.value.length > 10_000))) throw new Error("Unsupported action or stale element reference");
        const ref = String(action.element_ref).split(":")[1];
        const request: ControlAction = { operation: action.operation, value: action.value };
        // Recompute and check the snapshot inside the same JS task as the DOM action.
        const result = await evaluate(before.context, `(() => {
          if (JSON.stringify(${SNAPSHOT}) !== ${JSON.stringify(before.raw)}) throw new Error('stale observation');
          const el = globalThis.__craftControl.nodes.get(${JSON.stringify(ref)});
          const action = ${JSON.stringify(request)};
          if (!el || !el.isConnected || el.matches(':disabled,[aria-disabled="true"]')) throw new Error('unavailable element');
          if (action.operation === 'fill') {
            if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || el.readOnly || el.matches('[type="password"],[type="file"],[autocomplete="one-time-code"]')) throw new Error('not an authorized editable control');
            el.focus(); el.value = action.value;
            el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true }));
          } else {
            const destination = el.href || el.formAction || (el.form && el.form.action) || (el instanceof HTMLFormElement && el.action);
            if (destination && !${JSON.stringify(origins)}.includes(new URL(destination, location.href).origin)) throw new Error('unauthorized destination');
            if (action.operation === 'click') el.click();
            else { const form = el instanceof HTMLFormElement ? el : el.closest('form'); if (!form) throw new Error('no form'); form.requestSubmit(); }
          }
          return { dispatched: true };
        })()`);
        if (!result || (result as { dispatched: unknown }).dispatched !== true) throw new Error("Browser action lacks dispatch receipt");
        return { receipt_digest: stableDigest({ operation: action.operation, result }) };
      });
    },
  };
  return { adapter, close };
}
