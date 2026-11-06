import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { createBrowserControlAdapter } from "../adapters/browser-control.ts";
import type { ControlAction } from "../capability/control-session.ts";

function fixture() {
  let contextId = 1, calls = 0, closes = 0, mode = "", takeover = false, epoch = false;
  class Element {
    tagName = "BUTTON"; isConnected = true; disabled = false; clicked = 0; href = ""; formAction = "";
    attributes: Record<string, string> = {}; form: Form | null = null;
    getAttribute(key: string) { return this.attributes[key] ?? null; }
    getBoundingClientRect() { return { x: 1, y: 2, width: 30, height: 20 }; }
    matches(selector: string) { return selector.includes('disabled') ? this.disabled : ["password", "file"].includes(this.attributes.type) || this.attributes.autocomplete === "one-time-code"; }
    click() { this.clicked++; } closest() { return this.form; }
  }
  class Input extends Element { tagName = "INPUT"; value = ""; events: string[] = []; focus() {} dispatchEvent(event: Event) { this.events.push(event.type); } }
  class Textarea extends Input { tagName = "TEXTAREA"; }
  class Form extends Element { tagName = "FORM"; action = "http://localhost:9000/submit"; submitted = 0; requestSubmit() { this.submitted++; } }
  const button = new Element(), input = new Input(), textarea = new Textarea(), form = new Form(); button.form = form;
  let elements: Element[] = [button, input, textarea, form];
  const document = { readyState: "complete", querySelectorAll: () => elements, querySelector: () => takeover ? input : null };
  const location = { origin: "http://localhost:9000", href: "http://localhost:9000/" };
  const world = createContext({ document, location, HTMLInputElement: Input, HTMLTextAreaElement: Textarea, HTMLFormElement: Form,
    URL, Event, MutationObserver: class { observe() {} takeRecords() { const changed = epoch; epoch = false; return changed ? [{}] : []; } } });
  const session = { close() { closes++; }, async call(method: string, params: Record<string, unknown> = {}) {
    calls++;
    if (mode === "throw") throw new Error("RAW SECRET");
    if (method === "Target.getTargetInfo") return { targetInfo: mode === "missing-target" ? undefined : { targetId: mode === "target" ? "other" : "tab", type: mode === "worker" ? "worker" : "page" } };
    if (method === "Page.getFrameTree") return { frameTree: mode === "frame" ? {} : { frame: { id: "frame" } } };
    if (method === "Page.createIsolatedWorld") { assert.equal(params.grantUniveralAccess, false); return { executionContextId: mode === "context" ? 0 : contextId }; }
    if (method === "Page.navigate") return mode === "navigation-error" ? { errorText: "SECRET" } : mode === "navigation-missing" ? {} : { frameId: "frame" };
    assert.equal(method, "Runtime.evaluate"); assert.equal(params.contextId, contextId);
    if (mode === "exception") return { exceptionDetails: { text: "SECRET" } };
    if (mode === "missing-value") return {};
    if (mode === "no-value") return { result: {} };
    if (mode === "bad-observation") return { result: { value: null } };
    if (mode === "bad-receipt") return { result: { value: null } };
    if (mode === "false-receipt") return { result: { value: { dispatched: false } } };
    if (mode.startsWith("invalid-")) return { result: { value: { origin: location.origin, takeover: mode === "invalid-takeover" ? null : false,
      nodes: mode === "invalid-nodes" ? null : mode === "invalid-capacity" ? Array(101).fill({ ref: "1" }) : mode === "invalid-null" ? [null] : mode === "invalid-ref" ? [{ ref: "bad" }] : [{ ref: "1" }, { ref: "1" }] } } };
    try { return { result: { value: structuredClone(runInContext(String(params.expression), world)) } }; }
    catch { return { exceptionDetails: { text: "script error" } }; }
  } };
  const host = createBrowserControlAdapter(session, "tab", [location.origin]);
  const signal = new AbortController().signal;
  const observe = () => host.adapter.observe("tab", signal);
  const execute = (action: ControlAction) => host.adapter.execute("tab", action, signal);
  return { host, session, signal, observe, execute, button, input, textarea, form, location, document,
    setMode: (value: string) => { mode = value; }, setTakeover: (value: boolean) => { takeover = value; }, setEpoch: () => { epoch = true; },
    setContext: (value: number) => { contextId = value; }, setElements: (value: Element[]) => { elements = value; }, calls: () => calls, closes: () => closes };
}

test("fixed isolated scripts perform bounded DOM actions with opaque node references and content-free receipts", async () => {
  const f = fixture();
  const first = await f.observe(); assert.deepEqual(first.element_refs, ["1:1", "1:2", "1:3", "1:4"]);
  assert.deepEqual(await f.observe(), first); assert.equal(first.identity, "browser:tab");
  for (const index of [1, 2]) {
    const observation = await f.observe();
    const receipt = await f.execute({ operation: "fill", element_ref: observation.element_refs[index], value: "private-input" });
    assert.match(receipt.receipt_digest, /^sha256:/); assert.ok(!JSON.stringify(receipt).includes("private-input"));
  }
  assert.equal(f.input.value, "private-input"); assert.equal(f.textarea.value, "private-input"); assert.deepEqual(f.input.events, ["input", "change"]);
  await f.observe(); await f.execute({ operation: "click", element_ref: "1:1" }); assert.equal(f.button.clicked, 1);
  await f.observe(); await f.execute({ operation: "submit", element_ref: "1:1" });
  await f.observe(); await f.execute({ operation: "submit", element_ref: "1:4" }); assert.equal(f.form.submitted, 2);
  await f.observe(); assert.match((await f.execute({ operation: "navigate", url: "http://localhost:9000/next" })).receipt_digest, /^sha256:/);
  await assert.rejects(f.execute({ operation: "click", element_ref: "1:1" }), /failed/);
  f.host.close(); await assert.rejects(f.observe(), /unavailable/);
});

test("transport identity, frame, context, script and navigation failures produce only sanitized errors", async () => {
  for (const mode of ["throw", "missing-target", "target", "worker", "frame", "context", "exception", "missing-value", "no-value", "bad-observation", "invalid-takeover", "invalid-nodes", "invalid-capacity", "invalid-null", "invalid-ref", "invalid-duplicate"]) {
    const f = fixture(); f.setMode(mode); await assert.rejects(f.observe(), /^Error: Browser operation failed; reconcile any uncertain effect$/);
  }
  for (const mode of ["navigation-error", "navigation-missing", "bad-receipt", "false-receipt"]) {
    const f = fixture(); await f.observe(); f.setMode(mode);
    await assert.rejects(f.execute({ operation: ["bad-receipt", "false-receipt"].includes(mode) ? "click" : "navigate", url: "http://localhost:9000/", element_ref: "1:1" }), /failed/);
  }
  const f = fixture(); assert.throws(() => createBrowserControlAdapter(f.session, "../tab", []), /Pinned/);
  assert.throws(() => createBrowserControlAdapter(f.session, "tab", []), /Pinned/);
  for (const origin of ["bad", "http://localhost:9000/path", "http://u:p@localhost:9000", "file://", "null"]) {
    assert.throws(() => createBrowserControlAdapter(f.session, "tab", [origin]));
  }
  await assert.rejects(f.host.adapter.observe("other", f.signal), /unavailable/);
});

test("observations, login takeover, document drift and caller-supplied approval cannot authorize actions", async () => {
  const actions = [
    { operation: "click", element_ref: "stale" }, { operation: "scroll", element_ref: "1:1" },
    { operation: "fill", element_ref: "1:2" }, { operation: "fill", element_ref: "1:2", value: "x".repeat(10_001) },
    { operation: "click", element_ref: "1:1", human_release: true },
    { operation: "navigate", url: "http://other.test/" }, { operation: "navigate", url: "http://u:p@localhost:9000/" },
    { operation: "navigate", url: "bad" },
  ];
  for (const action of actions) { const f = fixture(); await f.observe(); await assert.rejects(f.execute(action), /failed/); assert.equal(f.button.clicked, 0); }
  const f = fixture(); f.setTakeover(true); assert.equal((await f.observe()).user_takeover, true);
  await assert.rejects(f.execute({ operation: "click", element_ref: "1:1" }), /failed/);
  f.setTakeover(false); await f.observe(); f.setContext(2); await assert.rejects(f.execute({ operation: "click", element_ref: "1:1" }), /failed/);
  f.setContext(1); await f.observe(); f.setEpoch(); await assert.rejects(f.execute({ operation: "click", element_ref: "1:1" }), /failed/);
  await f.observe(); f.setEpoch(); await assert.rejects(f.execute({ operation: "navigate", url: "http://localhost:9000/" }), /failed/);
  f.location.origin = "http://other.test"; await assert.rejects(f.observe(), /failed/);
  f.location.origin = "http://localhost:9000"; f.setElements(Array(101).fill(f.button)); await assert.rejects(f.observe(), /failed/);
});

test("fixed DOM action scripts reject unsafe controls, changed destinations and missing forms", async () => {
  for (const kind of ["disabled", "detached", "button-fill", "password", "file", "otp", "destination", "missing-form"]) {
    const f = fixture();
    if (kind === "disabled") f.button.disabled = true;
    if (kind === "detached") f.button.isConnected = false;
    if (kind === "password" || kind === "file") f.input.attributes.type = kind;
    if (kind === "otp") f.input.attributes.autocomplete = "one-time-code";
    if (kind === "destination") f.button.href = "http://other.test/";
    if (kind === "missing-form") f.button.form = null;
    await f.observe();
    const fill = ["button-fill", "password", "file", "otp"].includes(kind);
    await assert.rejects(f.execute({ operation: fill ? "fill" : kind === "missing-form" ? "submit" : "click", element_ref: fill && kind !== "button-fill" ? "1:2" : "1:1", value: "text" }), /failed/);
  }
});

test("cancellation closes the transport and never silently reconnects", async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  await assert.rejects(f.host.adapter.observe("tab", controller.signal), /cancelled/); assert.equal(f.calls(), 0);
  const original = f.session.call;
  const pendingController = new AbortController();
  f.session.call = async (method, params) => { const result = await original(method, params); pendingController.abort(); return result; };
  await assert.rejects(f.host.adapter.observe("tab", pendingController.signal), /failed/); assert.equal(f.closes(), 1);
  await assert.rejects(f.observe(), /unavailable/);
});

test("form property drift invalidates approval without exporting private field values", async () => {
  for (const change of [{ value: "secret-after-approval" }, { checked: true }, { indeterminate: true },
    { readOnly: true }, { selectedIndex: 2 }, { options: [{ selected: false }, { selected: true }] }]) {
    const f = fixture();
    const before = await f.observe();
    Object.assign(f.input, change);
    await assert.rejects(f.execute({ operation: "submit", element_ref: "1:4" }), /failed/);
    assert.equal(f.form.submitted, 0);
    const after = await f.observe();
    assert.notEqual(after.state_digest, before.state_digest);
    assert.ok(!JSON.stringify(after).includes("secret-after-approval"));
    assert.deepEqual(await f.observe(), after);
  }
  const f = fixture(); Object.assign(f.input, { readOnly: true });
  await f.observe(); await assert.rejects(f.execute({ operation: "fill", element_ref: "1:2", value: "overwrite" }), /failed/);
  assert.equal(f.input.value, "");
});
