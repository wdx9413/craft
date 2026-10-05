import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { connectCdp } from "../../adapters/cdp-session.ts";
import { createBrowserControlAdapter } from "../../adapters/browser-control.ts";
import { createControlSession } from "../../capability/control-session.ts";
import { createStoreControlAuthority } from "../../core/application/control-authority.ts";
import { CraftStore, type JsonObject } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CraftService } from "../../core/service.ts";
import { CapabilityKitRuntime } from "../../core/capability-kit-runtime.ts";
import { CRAFT_RELEASE_VERSION } from "../../core/version.ts";

// Explicit local smoke only: never runs in ordinary tests or downloads a browser.
const executable = process.argv[2];
if (!executable || !isAbsolute(executable) || !(await stat(executable)).isFile()) throw new Error("Explicit installed Chromium executable required");
const root = await mkdtemp(join(tmpdir(), "craft-browser-live-"));
const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
  response.end('<!doctype html><title>Craft controlled fixture</title><form action="/done"><input name="test"><button type="button" onclick="document.body.dataset.clicked=Number(document.body.dataset.clicked||0)+1">Click</button></form>');
});
const store = await new CraftStore(craftPaths(join(root, "data"))).open();
let child: ReturnType<typeof spawn> | undefined;
let control: ReturnType<typeof createBrowserControlAdapter> | undefined;
try {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  child = spawn(executable, ["--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-extensions", "--disable-component-update", "--disable-sync", "--disable-default-apps", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", `--user-data-dir=${join(root, "profile")}`, origin], { stdio: ["ignore", "ignore", "pipe"] });
  child.stderr!.resume(); // Drain without retaining raw browser logs.
  let launchError = false; child.on("error", () => { launchError = true; });
  let port = 0;
  for (let attempt = 0; attempt < 100 && !port; attempt++) {
    if (launchError || child.exitCode !== null || child.signalCode !== null) throw new Error("Isolated Chromium exited before readiness");
    try { port = Number((await readFile(join(root, "profile", "DevToolsActivePort"), "utf8")).split("\n")[0]); } catch { await delay(100); }
  }
  if (!port) throw new Error("Isolated Chromium readiness timeout");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(5_000), redirect: "error" })).json() as { id: string; type: string; url: string }[];
  const pages = targets.filter(target => target.type === "page" && target.url.startsWith(origin));
  assert.equal(pages.length, 1);
  const target = pages[0].id;
  const cdp = await connectCdp(port, target);
  control = createBrowserControlAdapter(cdp, target, [origin]);
  let ready = false;
  for (let attempt = 0; attempt < 50 && !ready; attempt++) {
    const loaded = await cdp.call("Runtime.evaluate", { expression: `document.readyState === "complete" && location.origin === ${JSON.stringify(origin)} && Boolean(document.querySelector("input"))`, returnByValue: true });
    ready = (loaded.result as { value?: unknown } | undefined)?.value === true;
    if (!ready) await delay(100);
  }
  assert.equal(ready, true, "Local fixture must finish loading before opening its Session");
  const service = new CraftService(store), kits = new CapabilityKitRuntime(store);
  const task = service.taskOpen({ title: "Explicit local Chromium proof", goal: "Operate only the local fixture", project_id: "fixture", permission_mode: "human_approval" }).task as JsonObject;
  store.create("activation_profile", "profile", { task_id: task.id, allowed_effects: ["external_write"], activation: "host_mediated", status: "recommended" });
  service.taskControlSave({ contract_id: "contract", task_id: task.id, workspace: root, allowed_effects: ["external_write"], acceptance_required: true, activation_profile_id: "profile", activation_profile_version: 1 });
  kits.install({ manifest: { id: "test.browser", version: "1.0.0", name: "Local browser fixture", description: "Controlled local smoke", compatibility: `^${CRAFT_RELEASE_VERSION}`, provides: ["browser_control"], effects: ["external_write"], data_scopes: ["project_root"], entrypoints: ["observe"], hooks: ["execute.adapter"], surfaces: ["cli"], healthcheck: "fixture", eval_suite: "fixture" } });
  kits.conformance({ kit_id: "test.browser" });
  kits.activate({ kit_id: "test.browser", task_id: task.id, activation_id: "activation", activation_profile_id: "profile" });
  const scope = { task_id: String(task.id), activation_id: "activation", target_id: target };
  const authority = createStoreControlAuthority(store, { ...scope, principal: "fixture-operator", project_id: "fixture", host_id: "local-smoke", contract_id: "contract", effect: "external_write", target_identity: `browser:${target}`, operations: ["fill", "click", "navigate"], allowed_origins: [origin], expires_at: Date.now() + 30_000, timeout_ms: 5_000, max_actions: 3 });
  const host = createControlSession(store, authority, control.adapter);
  const session = host.client.open(scope);
  const observation = await host.client.observe(String(session.id));
  // DOM ordering is frozen by this fixture: form, input, button.
  const action = host.client.prepare(String(session.id), String(observation.id), { operation: "fill", element_ref: (observation.element_refs as string[])[1], value: "local-proof" });
  assert.throws(() => host.approve(String(action.id), "forged", "forged"), /principal/);
  host.approve(String(action.id), "fixture-operator", String(host.approvalPacket(String(action.id)).packet_digest));
  const result = await host.client.execute(String(action.id)); assert.equal(result.status, "observed"); assert.equal(result.outcome_accepted, false);
  const verify = await cdp.call("Runtime.evaluate", { expression: 'document.querySelector("input").value === "local-proof"', returnByValue: true });
  assert.equal((verify.result as { value: unknown }).value, true);
  const second = await host.client.observe(String(session.id));
  const click = host.client.prepare(String(session.id), String(second.id), { operation: "click", element_ref: (second.element_refs as string[])[2] });
  host.approve(String(click.id), "fixture-operator", String(host.approvalPacket(String(click.id)).packet_digest));
  assert.equal((await host.client.execute(String(click.id))).status, "observed");
  const clicked = await cdp.call("Runtime.evaluate", { expression: 'document.body.dataset.clicked === "1"', returnByValue: true });
  assert.equal((clicked.result as { value: unknown }).value, true);
  const third = await host.client.observe(String(session.id));
  assert.throws(() => host.client.prepare(String(session.id), String(third.id), { operation: "navigate", url: "http://other.invalid/" }), /authorized/);
  const stale = host.client.prepare(String(session.id), String(third.id), { operation: "click", element_ref: (third.element_refs as string[])[2] });
  host.approve(String(stale.id), "fixture-operator", String(host.approvalPacket(String(stale.id)).packet_digest));
  // A value property write emits no attribute mutation: this exercises the
  // approval-drift regression in Chromium, not just in the injected-script VM.
  await cdp.call("Runtime.evaluate", { expression: 'document.querySelector("input").value = "changed-after-approval"', returnByValue: true });
  assert.equal((await host.client.execute(String(stale.id))).status, "handoff");
  const notRepeated = await cdp.call("Runtime.evaluate", { expression: 'document.body.dataset.clicked === "1"', returnByValue: true });
  assert.equal((notRepeated.result as { value: unknown }).value, true);
  assert.equal(host.client.close(String(session.id)).status, "closed");
  process.stdout.write("PASS isolated Chromium: real ledger binding, approved fill/click, independent DOM assertions, forged approval/origin rejection and form-property drift handoff; no UI/native-platform claim.\n");
} finally {
  control?.close();
  if (child?.pid && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill("SIGTERM");
    const timer = setTimeout(() => child!.kill("SIGKILL"), 2_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
  store.close(); await rm(root, { recursive: true, force: true });
}
