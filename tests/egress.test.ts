import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { PassThrough } from "node:stream";
import { TrustedEgressBroker, createHttpsTransport, egressRequestDigest, isPrivateEgressAddress, resolvePublic, type EgressTransport } from "../src/egress.ts";
import { McpServer } from "../src/mcp.ts";
import { craftPaths } from "../src/paths.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

test("trusted egress injects only at a public pinned transport and redacts the response", async () => {
  let observed: Parameters<EgressTransport>[0] | undefined;
  const broker = new TrustedEgressBroker({ SERVICE_KEY: "super-secret" }, async () => [{ address: "203.0.113.8", family: 4 }],
    async (input) => { observed = input; return { status: 200, headers: { "x-note": "token=abc", "set-cookie": "bad" },
      body: "super-secret authorization=raw", output_limited: false }; });
  const digest = egressRequestDigest("post", "https://api.example.com/v1", { accept: "application/json", "content-type": "application/json" }, "{}");
  const result = await broker.execute({ url: "https://api.example.com/v1", method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: "{}", request_digest: digest, secret_ref: "env:SERVICE_KEY" });
  assert.equal(observed?.headers.authorization, "Bearer super-secret"); assert.equal(observed?.address, "203.0.113.8");
  assert.equal(String(result.body).includes("super-secret"), false); assert.equal((result.headers as JsonObject)["set-cookie"], undefined);
  assert.match(String((result.headers as JsonObject)["x-note"]), /REDACTED/);
});

test("trusted egress fails closed for malformed requests, private DNS, credentials, redirects, and missing secrets", async () => {
  const response = { status: 200, headers: {}, body: "ok", output_limited: false };
  const publicResolver = async () => [{ address: "8.8.8.8", family: 4 }];
  const execute = (extra: JsonObject, broker = new TrustedEgressBroker({ KEY: "value" }, publicResolver, async () => response)) =>
    broker.execute({ url: "https://example.com", method: "GET", request_digest: egressRequestDigest("GET", "https://example.com", {}, ""), secret_ref: "env:KEY", ...extra });
  await assert.rejects(execute({ url: "http://example.com" }), /HTTPS/);
  await assert.rejects(execute({ url: "https://u:p@example.com" }), /HTTPS/);
  await assert.rejects(execute({ method: "OPTIONS" }), /method/);
  await assert.rejects(execute({ request_digest: "wrong" }), /digest/);
  await assert.rejects(execute({ secret_ref: "env:MISSING" }), /unavailable/);
  await assert.rejects(execute({ secret_ref: "literal" }), /unavailable/);
  await assert.rejects(execute({ header_name: "bad name" }), /header name/);
  await assert.rejects(execute({ headers: { authorization: "secret" } }), /forbidden/);
  await assert.rejects(execute({ headers: { okay: "line\nbreak" } }), /line breaks/);
  await assert.rejects(execute({}, new TrustedEgressBroker({ KEY: "value" }, async () => [{ address: "127.0.0.1", family: 4 }], async () => response)), /public/);
  await assert.rejects(execute({}, new TrustedEgressBroker({ KEY: "value" }, publicResolver, async () => ({ ...response, status: 302 }))), /redirect/);
  for (const address of ["0.0.0.1", "10.0.0.1", "127.0.0.1", "224.0.0.1", "169.254.1.1", "172.16.0.1", "172.31.0.1",
    "192.168.0.1", "100.64.0.1", "100.127.0.1", "::", "::1", "fc00::1", "fd00::1", "fe80::1", "ff00::1", "::ffff:127.0.0.1", "invalid"])
    assert.equal(isPrivateEgressAddress(address), true);
  for (const address of ["1.1.1.1", "172.15.0.1", "172.32.0.1", "169.253.1.1", "192.167.1.1", "100.63.0.1", "100.128.0.1", "2001:4860:4860::8888"])
    assert.equal(isPrivateEgressAddress(address), false);
  await assert.rejects(resolvePublic("empty", async () => []), /private/);
  await assert.rejects(resolvePublic("private", async () => [{ address: "127.0.0.1", family: 4 }] as never), /private/);
  assert.deepEqual(await resolvePublic("public", async () => [{ address: "8.8.8.8", family: 4 }] as never), [{ address: "8.8.8.8", family: 4 }]);
  assert.throws(() => egressRequestDigest(" ", "https://example.com", {}, ""), /method/);
  assert.throws(() => egressRequestDigest("GET", " ", {}, ""));
  assert.throws(() => egressRequestDigest("GET", "https://example.com", [], ""), /headers/);
  assert.throws(() => egressRequestDigest("GET", "https://example.com", { authorization: "x" }, ""), /forbidden/);
  assert.throws(() => egressRequestDigest("GET", "https://example.com", {}, { value: 1 }), /body/);
  assert.throws(() => egressRequestDigest("GET", "https://example.com", {}, "x".repeat(1024 * 1024 + 1)), /1 MiB/);
});

function requester(mode: "success" | "nostatus" | "limited" | "timeout" | "error", observed: { body?: string; lookup?: string }) {
  return ((_url: URL, options: JsonObject, callback: (response: PassThrough & { statusCode: number; headers: JsonObject }) => void) => {
    const outgoing = new EventEmitter() as EventEmitter & { write: (value: string) => void; end: () => void; destroy: (error: Error) => void };
    outgoing.write = (value) => { observed.body = value; };
    outgoing.destroy = (error) => { queueMicrotask(() => outgoing.emit("error", error)); };
    outgoing.end = () => queueMicrotask(() => {
      if (mode === "timeout") { outgoing.emit("timeout"); return; }
      if (mode === "error") { outgoing.emit("error", new Error("socket")); return; }
      const response = new PassThrough() as PassThrough & { statusCode?: number; headers: JsonObject };
      response.statusCode = mode === "success" ? 200 : undefined; response.headers = { "x-array": ["a", "b"], empty: undefined };
      const lookupCallback = (_error: Error | null, address: string) => { observed.lookup = address; };
      (options.lookup as (host: string, options: JsonObject, callback: typeof lookupCallback) => void)("ignored", {}, lookupCallback);
      callback(response as never); response.write(mode === "limited" ? "12345" : "ok"); if (mode === "success" || mode === "nostatus") response.end();
    });
    return outgoing;
  }) as unknown as Parameters<typeof createHttpsTransport>[0];
}

test("HTTPS transport pins DNS, streams bounded output, writes bodies, and rejects socket failures", async () => {
  const input = { url: new URL("https://example.com"), method: "POST", headers: {}, body: "payload", address: "8.8.8.8",
    family: 4, timeout_ms: 100, output_limit: 4 };
  const observed: { body?: string; lookup?: string } = {};
  const success = await createHttpsTransport(requester("success", observed))({ ...input, output_limit: 10 });
  assert.equal(success.body, "ok"); assert.equal(success.headers["x-array"], "a, b"); assert.equal(success.headers.empty, "");
  assert.equal(observed.body, "payload"); assert.equal(observed.lookup, "8.8.8.8");
  const limited = await createHttpsTransport(requester("limited", {}))(input); assert.equal(limited.output_limited, true);
  assert.equal((await createHttpsTransport(requester("nostatus", {}))(input)).status, 0);
  await assert.rejects(createHttpsTransport(requester("timeout", {}))({ ...input, body: "" }), /timed out/);
  await assert.rejects(createHttpsTransport(requester("error", {}))(input), /socket/);
  const defaultTransportBroker = new TrustedEgressBroker({ KEY: "value" }, async () => [{ address: "8.8.8.8", family: 4 }],
    undefined, requester("success", {}));
  const digest = egressRequestDigest("GET", "https://example.com", {}, "");
  assert.equal((await defaultTransportBroker.execute({ url: "https://example.com", method: "GET", request_digest: digest,
    secret_ref: "env:KEY" })).status, 200);
});

test("service executes an authorization once and persists only response evidence", async () => {
  const root = join(tmpdir(), `craft-egress-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open();
  const broker = new TrustedEgressBroker({ API_KEY: "hidden" }, async () => [{ address: "1.1.1.1", family: 4 }],
    async () => ({ status: 201, headers: {}, body: "created", output_limited: false }));
  const service = new CraftService(store, undefined, undefined, undefined, broker);
  try {
    const task = service.taskOpen({ title: "Egress", goal: "Call exact API" }).task as JsonObject;
    assert.throws(() => service.credentialHandleRegister({ provider: "api", secret_ref: "env:API_KEY", header_name: "bad name" }), /header_name/);
    assert.throws(() => service.credentialHandleRegister({ provider: "api", secret_ref: "env:API_KEY", prefix: "bad\n" }), /prefix/);
    service.credentialHandleRegister({ handle_id: "key", provider: "api", secret_ref: "env:API_KEY", header_name: "x-service-key", prefix: "" });
    const lease = service.credentialLeaseIssue({ lease_id: "lease", task_id: task.id, handle_id: "key", allowed_hosts: ["api.example.com"],
      allowed_actions: ["create"], ttl_seconds: 3600, now: new Date(Date.now() - 1000).toISOString() }).lease as JsonObject;
    const digest = service.egressRequestDigest({ method: "POST", url: "https://api.example.com/items", body: "{}" }).request_digest;
    const auth = service.egressAuthorize({ lease_id: lease.id, receipt_id: "auth", url: "https://api.example.com/items", action: "create", request_digest: digest }).authorization as JsonObject;
    const completed = await service.egressExecute({ authorization_id: auth.id, method: "POST", body: "{}" });
    assert.equal((completed.execution as JsonObject).status, "completed"); assert.equal((completed.response as JsonObject).body, "created");
    assert.equal(Object.hasOwn(store.get("egress_execution", "execution_auth"), "body"), false);
    assert.equal((await service.egressExecute({ authorization_id: auth.id, method: "POST", body: "{}" })).idempotent, true);
    const server = new McpServer(service, "full");
    assert.equal(((await server.handle({ id: 1, method: "tools/call", params: { name: "craft_egress_request_digest",
      arguments: { method: "GET", url: "https://api.example.com" } } }))?.result as JsonObject).isError, false);
    assert.equal(((await server.handle({ id: 2, method: "tools/call", params: { name: "craft_egress_execute",
      arguments: { authorization_id: auth.id, method: "POST", body: "{}" } } }))?.result as JsonObject).isError, false);

    service.sandboxProfileSave({ profile_id: "offline", name: "Offline", backend: "container", adapter_id: "test",
      capabilities: { filesystem: "workspace_overlay", network: "denied", features: ["process_isolation"], network_allowlist: [], limits: {} } });
    const proof = completed.evidence as JsonObject;
    service.sandboxProfileVerify({ profile_id: "offline", profile_version: 1,
      observed_capabilities: { filesystem: "workspace_overlay", network: "denied", features: ["process_isolation"], network_allowlist: [], limits: {} },
      evidence_ids: [proof.id], verifier: "test" });
    service.sandboxPlan({ task_id: task.id, profile_id: "offline", profile_version: 2,
      requirements: { filesystem: "workspace_overlay", network: "denied", features: [], limits: {} },
      request_digest: "sandbox-command", ticket_id: "offline-ticket" });
    const getDigest = egressRequestDigest("GET", "https://api.example.com/status", {}, "");
    const getAuth = service.egressAuthorize({ lease_id: lease.id, receipt_id: "sandbox-auth", url: "https://api.example.com/status",
      action: "create", request_digest: getDigest }).authorization as JsonObject;
    const delivered = await service.sandboxEgressDeliver({ binding_id: "delivery", ticket_id: "offline-ticket",
      authorization_id: getAuth.id, method: "GET", output_name: "status.json" });
    const envelope = JSON.parse(await readFile(fileURLToPath(String((delivered.binding as JsonObject).output_uri)), "utf8")) as JsonObject;
    assert.equal(envelope.trust, "untrusted_external_response"); assert.equal(envelope.execution_authority, false);
    assert.equal((await service.sandboxEgressDeliver({ binding_id: "delivery", ticket_id: "offline-ticket",
      authorization_id: getAuth.id, method: "GET", output_name: "status.json" })).idempotent, true);
    assert.equal(((await server.handle({ id: 3, method: "tools/call", params: { name: "craft_sandbox_egress_deliver",
      arguments: { binding_id: "delivery", ticket_id: "offline-ticket", authorization_id: getAuth.id, method: "GET", output_name: "status.json" } } }))?.result as JsonObject).isError, false);
    const defaultDigest = egressRequestDigest("GET", "https://api.example.com/default", {}, "");
    service.egressAuthorize({ lease_id: lease.id, receipt_id: "default-auth", url: "https://api.example.com/default", action: "create", request_digest: defaultDigest });
    const defaultDelivery = await service.sandboxEgressDeliver({ binding_id: "default-delivery", ticket_id: "offline-ticket",
      authorization_id: "default-auth", method: "GET" });
    assert.match(String((defaultDelivery.binding as JsonObject).output_name), /response\.json/);
    store.save("egress_authorization", "auth", { ...store.get("egress_authorization", "auth"), status: "authorized" });
    await assert.rejects(service.sandboxEgressDeliver({ binding_id: "unavailable-delivery", ticket_id: "offline-ticket",
      authorization_id: "auth", method: "POST", body: "{}" }), /unavailable/);
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});

test("service blocks invalid authorization state and ambiguous transport failures", async () => {
  const root = join(tmpdir(), `craft-egress-errors-${process.pid}-${Date.now()}`); const store = await new CraftStore(craftPaths(root)).open();
  const broker = new TrustedEgressBroker({ KEY: "hidden" }, async () => [{ address: "1.1.1.1", family: 4 }], async () => { throw new Error("network uncertain"); });
  const service = new CraftService(store, undefined, undefined, undefined, broker);
  try {
    const task = service.taskOpen({ title: "Egress", goal: "Fail safely" }).task as JsonObject;
    service.credentialHandleRegister({ handle_id: "key", provider: "api", secret_ref: "env:KEY" });
    const lease = service.credentialLeaseIssue({ lease_id: "lease", task_id: task.id, handle_id: "key", allowed_hosts: ["api.example.com"], allowed_actions: ["read"], ttl_seconds: 3600 }).lease as JsonObject;
    const digest = egressRequestDigest("GET", "https://api.example.com", {}, "");
    service.egressAuthorize({ lease_id: lease.id, receipt_id: "uncertain", url: "https://api.example.com", action: "read", request_digest: digest });
    store.create("sandbox_profile", "offline", { lifecycle: "verified", backend: "container", adapter_id: "test",
      capabilities: { filesystem: "workspace_overlay", network: "denied", features: [], network_allowlist: [], limits: {} } });
    store.create("sandbox_ticket", "ticket", { task_id: task.id, profile_id: "offline", profile_version: 1,
      status: "issued", request_digest: "command" });
    await assert.rejects(service.sandboxEgressDeliver({ binding_id: "bridge-failure", ticket_id: "ticket",
      authorization_id: "uncertain", method: "GET" }), /uncertain/);
    await assert.rejects(service.sandboxEgressDeliver({ binding_id: "bridge-failure", ticket_id: "ticket",
      authorization_id: "uncertain", method: "GET" }), /ambiguous/);
    await assert.rejects(service.sandboxEgressDeliver({ binding_id: "bridge-failure", ticket_id: "ticket",
      authorization_id: "uncertain", method: "GET", output_name: "other.json" }), /idempotency/);
    await assert.rejects(service.egressExecute({ authorization_id: "uncertain", method: "GET" }), /ambiguous/);
    store.create("egress_authorization", "pending-auth", { lease_id: lease.id, handle_id: "key", task_id: task.id, status: "authorized", url: "https://api.example.com/", action: "read", request_digest: digest });
    store.create("egress_execution", "execution_pending-auth", { status: "pending" });
    await assert.rejects(service.egressExecute({ authorization_id: "pending-auth", method: "GET" }), /ambiguous/);
    store.create("egress_authorization", "used", { lease_id: lease.id, handle_id: "key", task_id: task.id, status: "consumed", url: "https://api.example.com/", action: "read", request_digest: digest });
    await assert.rejects(service.egressExecute({ authorization_id: "used", method: "GET" }), /not executable/);
    await assert.rejects(service.sandboxEgressDeliver({ binding_id: "used-binding", ticket_id: "ticket",
      authorization_id: "used", method: "GET" }), /not executable/);
    await assert.rejects(service.sandboxEgressDeliver({ binding_id: "bad-name", ticket_id: "ticket",
      authorization_id: "used", method: "GET", output_name: "../bad.json" }), /safe JSON/);
    store.create("sandbox_profile", "online", { lifecycle: "verified", backend: "container", adapter_id: "test",
      capabilities: { filesystem: "read_only", network: "allowlist", features: [], network_allowlist: ["api.example.com"], limits: {} } });
    store.create("sandbox_ticket", "online-ticket", { task_id: task.id, profile_id: "online", profile_version: 1, status: "issued", request_digest: "command" });
    await assert.rejects(service.sandboxEgressDeliver({ binding_id: "online-binding", ticket_id: "online-ticket",
      authorization_id: "used", method: "GET" }), /denied network/);
    store.create("sandbox_profile", "readonly", { lifecycle: "verified", backend: "container", adapter_id: "test",
      capabilities: { filesystem: "read_only", network: "denied", features: [], network_allowlist: [], limits: {} } });
    store.create("sandbox_ticket", "readonly-ticket", { task_id: task.id, profile_id: "readonly", profile_version: 1, status: "issued", request_digest: "command" });
    await assert.rejects(service.sandboxEgressDeliver({ binding_id: "readonly-binding", ticket_id: "readonly-ticket",
      authorization_id: "used", method: "GET" }), /workspace overlay/);
    store.create("sandbox_ticket", "closed-ticket", { task_id: task.id, profile_id: "offline", profile_version: 1, status: "completed", request_digest: "command" });
    await assert.rejects(service.sandboxEgressDeliver({ binding_id: "closed-binding", ticket_id: "closed-ticket",
      authorization_id: "used", method: "GET" }), /active ticket/);
    const otherTask = service.taskOpen({ title: "Other", goal: "Other" }).task as JsonObject;
    store.create("egress_authorization", "other-task-auth", { lease_id: lease.id, handle_id: "key", task_id: otherTask.id,
      status: "authorized", url: "https://api.example.com/", action: "read", request_digest: digest });
    await assert.rejects(service.sandboxEgressDeliver({ binding_id: "other-task-binding", ticket_id: "ticket",
      authorization_id: "other-task-auth", method: "GET" }), /same task/);
    service.egressAuthorize({ lease_id: lease.id, receipt_id: "bad-digest", url: "https://api.example.com", action: "read", request_digest: digest });
    await assert.rejects(service.egressExecute({ authorization_id: "bad-digest", method: "POST" }), /digest/);
    service.egressAuthorize({ lease_id: lease.id, receipt_id: "inactive", url: "https://api.example.com", action: "read", request_digest: digest });
    store.save("credential_lease", "lease", { ...store.get("credential_lease", "lease"), status: "revoked" });
    await assert.rejects(service.egressExecute({ authorization_id: "inactive", method: "GET" }), /inactive/);
    const liveLease = service.credentialLeaseIssue({ lease_id: "live", task_id: task.id, handle_id: "key", allowed_hosts: ["api.example.com"], allowed_actions: ["read"], ttl_seconds: 3600 }).lease as JsonObject;
    service.egressAuthorize({ lease_id: liveLease.id, receipt_id: "handle-off", url: "https://api.example.com", action: "read", request_digest: digest });
    store.save("credential_handle", "key", { ...store.get("credential_handle", "key"), status: "revoked" });
    await assert.rejects(service.egressExecute({ authorization_id: "handle-off", method: "GET" }), /handle/);
    store.save("credential_handle", "key", { ...store.get("credential_handle", "key"), status: "active" });
    store.create("egress_authorization", "string-error", { lease_id: liveLease.id, handle_id: "key", task_id: task.id,
      status: "authorized", url: "https://api.example.com/", action: "read", request_digest: digest });
    const stringBroker = new TrustedEgressBroker({ KEY: "hidden" }, async () => [{ address: "1.1.1.1", family: 4 }],
      async () => { throw "uncertain string"; });
    const stringService = new CraftService(store, undefined, undefined, undefined, stringBroker);
    let caught: unknown; try { await stringService.egressExecute({ authorization_id: "string-error", method: "GET" }); } catch (error) { caught = error; }
    assert.equal(caught, "uncertain string"); assert.equal(store.get("egress_execution", "execution_string-error").error_class, "UnknownError");
    store.create("egress_authorization", "bridge-string-auth", { lease_id: liveLease.id, handle_id: "key", task_id: task.id,
      status: "authorized", url: "https://api.example.com/", action: "read", request_digest: digest });
    caught = undefined; try { await stringService.sandboxEgressDeliver({ binding_id: "bridge-string", ticket_id: "ticket",
      authorization_id: "bridge-string-auth", method: "GET" }); } catch (error) { caught = error; }
    assert.equal(caught, "uncertain string"); assert.equal(store.get("sandbox_egress_binding", "bridge-string").error_class, "UnknownError");
  } finally { store.close(); await rm(root, { recursive: true, force: true }); }
});
