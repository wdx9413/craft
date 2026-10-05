import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { request } from "node:https";
import { writeFileSync } from "node:fs";
import { startDeployment, type DeploymentConfig } from "../deploy/components/server.ts";

const hash = (value: string) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
test("deployable HTTPS component binds verified principals to isolated tenant stores", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-remote-")), fetchBefore = globalThis.fetch;
  let runtime: Awaited<ReturnType<typeof startDeployment>> | undefined;
  try {
    const key = join(root, "key.pem"), cert = join(root, "cert.pem"), auth = join(root, "introspection.txt");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
    writeFileSync(auth, "Basic fixture-introspection-credential");
    const config: DeploymentConfig = { issuer: "https://issuer.test", audience: "https://craft.test/mcp", introspection_url: "https://issuer.test/introspect", introspection_authorization_file: auth, tls_key_file: key, tls_cert_file: cert, data_root: join(root, "data"), product: "memory", host: "127.0.0.1", port: 0, routes: { [hash("alice")]: "tenant_a", [hash("bob")]: "tenant_b" } };
    await assert.rejects(() => startDeployment({ ...config, introspection_url: "http://issuer.test" }), /HTTPS/);
    await assert.rejects(() => startDeployment({ ...config, routes: {} }), /routes/);
    await assert.rejects(() => startDeployment({ ...config, routes: { [hash("alice")]: "../escape" } }), /routes/);
    await assert.rejects(() => startDeployment({ ...config, product: "full" }), /standalone/);
    for (const product of ["context", "codebase"]) await assert.rejects(() => startDeployment({ ...config, product }), /one tenant/);
    await assert.rejects(() => startDeployment({ ...config, tls_key_file: join(root, "missing") }), /ENOENT/);
    const configFile = join(root, "config.json"); writeFileSync(configFile, JSON.stringify({ ...config, data_root: join(root, "child-data") }));
    const child = spawn(process.execPath, ["deploy/components/server.ts", configFile], { stdio: ["ignore", "ignore", "pipe"] });
    await new Promise<void>((done, reject) => { let diagnostic = ""; const timeout = setTimeout(() => { child.kill(); reject(new Error(`deployment CLI startup timed out: ${diagnostic}`)); }, 5000); child.stderr.on("data", chunk => { diagnostic = (diagnostic + String(chunk)).slice(-2000); if (diagnostic.includes("HTTPS ready")) { clearTimeout(timeout); done(); } }); child.once("exit", code => { clearTimeout(timeout); reject(new Error(`deployment CLI exited ${code}: ${diagnostic}`)); }); child.once("error", reject); });
    const exited = new Promise<void>(done => child.once("exit", () => done())); child.kill("SIGTERM"); await exited;
    assert.throws(() => execFileSync(process.execPath, ["deploy/components/server.ts"], { stdio: "pipe" }), /Usage/);
    execFileSync(process.execPath, ["--input-type=module", "-e", "await import('./deploy/components/server.ts')"], { stdio: "pipe" });
    globalThis.fetch = (async (_url: unknown, options: RequestInit) => {
      assert.equal((options.headers as Record<string, string>).authorization, "Basic fixture-introspection-credential");
      const token = new URLSearchParams(options.body as URLSearchParams).get("token");
      if (token === "unavailable") return new Response("", { status: 503 });
      if (token === "huge") return new Response("x".repeat(65_537));
      return Response.json({ active: token !== "inactive", sub: token, iss: config.issuer, aud: token === "wrong-audience" ? "other" : config.audience, exp: Math.floor(Date.now() / 1000) + 3600, scope: token === "missing-scope" ? null : "craft.invoke" });
    }) as typeof fetch;
    runtime = await startDeployment(config); let port = (runtime.server.address() as { port: number }).port; const ca = await readFile(cert);
    const send = (token: string | null, method: string, params?: unknown) => new Promise<{ status: number; body: any }>((done, reject) => {
      const req = request({ host: "127.0.0.1", servername: "localhost", port, path: "/mcp", method: "POST", ca, headers: { "content-type": "application/json", accept: "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) } }, response => {
        let body = ""; response.on("data", chunk => body += chunk); response.on("end", () => done({ status: response.statusCode!, body: JSON.parse(body) }));
      }); req.on("error", reject); req.end(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
    });
    for (const token of [null, "unmapped", "inactive", "wrong-audience", "missing-scope", "unavailable", "huge"]) assert.equal((await send(token, "tools/list")).status, 401);
    for (const token of ["alice", "bob"]) assert.equal((await send(token, "initialize", { protocolVersion: "2025-11-25" })).status, 200);
    const call = async (token: string, name: string, args: object = {}) => {
      const response = await send(token, "tools/call", { name, arguments: args });
      assert.equal(response.status, 200); assert.equal(response.body.result.isError, false, JSON.stringify(response.body)); return response.body.result.structuredContent;
    };
    await call("alice", "craft_knowledge_bootstrap_install");
    await call("alice", "craft_memory_capture_user_statement", { scope_kind: "project", scope_id: "same", content: "Alice prefers scoped verification", explicit_consent: true, auto_accept: true });
    const scope = { scope_kind: "project", scope_id: "same" };
    assert.equal((await call("alice", "craft_memory_ledger_list", scope)).memories.length, 1);
    assert.equal((await call("bob", "craft_memory_ledger_list", scope)).memories.length, 0);
    const forged = await send("bob", "tools/call", { name: "craft_memory_ledger_list", arguments: { ...scope, tenant_id: "tenant_a" } }); assert.equal(forged.body.result.isError, true);
    runtime.close(); runtime = undefined;
    runtime = await startDeployment({ ...config, product: "context", routes: { [hash("alice")]: "tenant_a" } });
    port = (runtime.server.address() as { port: number }).port;
    assert.equal((await send("bob", "tools/list")).status, 401);
    assert.equal((await send("alice", "initialize", { protocolVersion: "2025-11-25" })).status, 200);
    assert((await send("alice", "tools/list")).body.result.tools.some((tool: { name: string }) => tool.name === "craft_context_open"));
    const pack = await call("alice", "craft_context_open", { project_root: root, query: "scoped verification" });
    assert.equal(pack.codebase.status, "skipped"); assert.equal(pack.codebase.reason, "not_repository");
    assert(pack.pack_receipt.id); assert.equal(pack.host_execution_authority, false);
  } finally { runtime?.close(); globalThis.fetch = fetchBefore; await rm(root, { recursive: true, force: true }); }
});
