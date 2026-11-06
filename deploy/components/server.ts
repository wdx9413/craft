/** Deploy one isolated data space per configured tenant; no request can choose its route. */
import { createServer } from "node:https";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { CraftStore } from "../../core/infrastructure/store.ts";
import { craftPaths } from "../../core/infrastructure/paths.ts";
import { CraftService } from "../../core/service.ts";
import { McpServer } from "../../core/mcp.ts";
import { productSurfaceOf } from "../../core/interfaces/mcp/product-launch.ts";
import { createMcpHttpHandler } from "../../core/interfaces/mcp-http.ts";
import { RemoteMcpAccessPolicy, RemoteMcpAccessError } from "../../core/remote-mcp-access.ts";
import type { TLSSocket } from "node:tls";
import type { JsonObject } from "../../core/infrastructure/store.ts";

/** Bind read-policy inputs to verified transport identity, never model-authored principals. */
export function bindRemoteIdentity(handler: McpServer, principalId: string, tenantId: string): Pick<McpServer, "handle"> {
  return { handle: async message => {
    const request = message as JsonObject | null;
    const params = request?.params as JsonObject | undefined;
    const tool = request?.method === "tools/call" ? handler.tools.find(item => item.name === params?.name) : undefined;
    if (!tool) return handler.handle(message);
    const args = params!.arguments ?? {};
    if (!args || typeof args !== "object" || Array.isArray(args)) return handler.handle(message);
    const bound: JsonObject = { principal_id: principalId, principal_ids: [principalId], tenant_id: tenantId };
    const properties = tool.inputSchema.properties as JsonObject;
    const argumentsWithIdentity = { ...args as JsonObject };
    for (const [key, value] of Object.entries(bound)) {
      if (!Object.hasOwn(properties, key)) continue;
      if (Object.hasOwn(argumentsWithIdentity, key) && JSON.stringify(argumentsWithIdentity[key]) !== JSON.stringify(value))
        return { jsonrpc: "2.0", id: request!.id, result: { isError: true, content: [{ type: "text", text: "Access identity must match the authenticated principal and tenant" }] } };
      argumentsWithIdentity[key] = value;
    }
    return handler.handle({ ...request, params: { ...params, arguments: argumentsWithIdentity } });
  } };
}

export interface DeploymentConfig {
  issuer: string; audience: string; introspection_url: string;
  introspection_authorization_file: string; tls_key_file: string; tls_cert_file: string;
  data_root: string; product: string; port: number; host: string;
  routes: Record<string, string>; // sha256(subject) -> server-owned tenant id
}
export async function startDeployment(config: DeploymentConfig) {
  if (new URL(config.introspection_url).protocol !== "https:") throw new Error("Introspection requires HTTPS");
  if (!Object.keys(config.routes).length || Object.entries(config.routes).some(([subject, tenant]) => !/^sha256:[a-f0-9]{64}$/.test(subject) || !/^[a-z0-9_-]{1,64}$/.test(tenant))) throw new Error("Explicit subject routes and safe tenant ids required");
  if (!["context", "knowledge", "memory", "experience", "codebase"].includes(config.product)) throw new Error("A standalone component product is required");
  // Database separation does not isolate a shared process's repository filesystem.
  if (["context", "codebase"].includes(config.product) && new Set(Object.values(config.routes)).size !== 1) throw new Error("Repository products require one tenant per isolated deployment");
  const stores: CraftStore[] = []; const tenants = new Map<string, McpServer>();
  try {
    for (const tenant of new Set(Object.values(config.routes))) {
      const store = await new CraftStore(craftPaths(resolve(config.data_root, tenant))).open(); stores.push(store);
      tenants.set(tenant, new McpServer(await CraftService.open(store), productSurfaceOf(config.product)));
    }
    const access = new RemoteMcpAccessPolicy({ issuer: config.issuer, audience: config.audience, requiredScopes: ["craft.invoke"], verifyAccessToken: async token => {
      const response = await fetch(config.introspection_url, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000), headers: { authorization: readFileSync(config.introspection_authorization_file, "utf8").trim(), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
      if (!response.ok) throw new RemoteMcpAccessError("Token introspection failed");
      const body = await response.text(); if (body.length > 65_536) throw new RemoteMcpAccessError("Introspection response exceeds budget");
      const value = JSON.parse(body);
      if (value.active !== true || typeof value.sub !== "string" || typeof value.exp !== "number" || !Number.isFinite(value.exp)) throw new RemoteMcpAccessError("Inactive or invalid principal");
      return { subject: value.sub, issuer: value.iss, audience: value.aud, scopes: typeof value.scope === "string" ? value.scope.split(/\s+/) : [], expires_at: new Date(value.exp * 1000).toISOString(), client_id: value.client_id };
    } });
    const http = createServer({ key: readFileSync(config.tls_key_file), cert: readFileSync(config.tls_cert_file), minVersion: "TLSv1.2" }, createMcpHttpHandler({ handle: async () => { throw new RemoteMcpAccessError("No unscoped runtime"); } }, {
      remoteAccess: access, secureTransport: request => (request.socket as TLSSocket).encrypted === true,
      authorizedHandler: receipt => {
        const tenant = Object.hasOwn(config.routes, receipt.subject_digest) ? config.routes[receipt.subject_digest] : undefined;
        const handler = tenant ? tenants.get(tenant) : undefined;
        if (!handler) throw new RemoteMcpAccessError("Principal has no configured tenant");
        return bindRemoteIdentity(handler, receipt.subject_digest, tenant!);
      },
    }));
    await new Promise<void>((done, reject) => { http.once("error", reject); http.listen(config.port, config.host, done); });
    return { server: http, close: () => { http.closeAllConnections(); http.close(); stores.forEach(store => store.close()); } };
  } catch (error) { stores.forEach(store => store.close()); throw error; }
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (!process.argv[2]) throw new Error("Usage: node deploy/components/server.ts config.json");
  const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const runtime = await startDeployment(config);
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => runtime.close());
  process.stderr.write("Craft component HTTPS ready; deployment still requires client acceptance.\n");
}
