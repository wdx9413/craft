// The MCP SDK is an optional adapter runtime, not a CLI-startup dependency: the
// sidecar must boot even when the SDK (or one of its transitive deps such as
// zod-to-json-schema) is not installed. Type-only imports are erased at runtime.
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JsonObject } from "./infrastructure/store.ts";
import { digestJson } from "./digest.ts";

type McpSdk = {
  Client: typeof import("@modelcontextprotocol/sdk/client/index.js").Client;
  StdioClientTransport: typeof import("@modelcontextprotocol/sdk/client/stdio.js").StdioClientTransport;
  StreamableHTTPClientTransport: typeof import("@modelcontextprotocol/sdk/client/streamableHttp.js").StreamableHTTPClientTransport;
};

let sdkModule: Promise<McpSdk> | null = null;

/** Load the SDK only when an MCP adapter is actually used. */
function mcpSdk(): Promise<McpSdk> {
  sdkModule ??= Promise.all([
    import("@modelcontextprotocol/sdk/client/index.js"),
    import("@modelcontextprotocol/sdk/client/stdio.js"),
    import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
  ]).then(([index, stdio, http]) => ({
    Client: index.Client,
    StdioClientTransport: stdio.StdioClientTransport,
    StreamableHTTPClientTransport: http.StreamableHTTPClientTransport,
  })).catch((error: unknown) => {
    sdkModule = null;
    throw new Error(`MCP SDK is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  });
  return sdkModule;
}

export type McpAdapterCall = {
  adapter_id: string;
  tool: string;
  arguments: JsonObject;
  timeout_ms?: number;
  output_limit?: number;
  /**
   * Add a bounded tools/list summary to the reply, read on the connection the
   * call already opened. Off by default: a caller that only wants one tool
   * result should not pay a second roundtrip on every call.
   */
  include_tool_inventory?: boolean;
};

/** A reply is evidence for one call, so the inventory is capped and named. */
const TOOL_INVENTORY_LIMIT = 50;

function metadata(manifest: JsonObject): JsonObject {
  return manifest.metadata && typeof manifest.metadata === "object" && !Array.isArray(manifest.metadata)
    ? manifest.metadata as JsonObject : {};
}

function stringArray(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) throw new Error(`${name} must be a string array`);
  return value as string[];
}

function stringRecord(value: unknown, name: string): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new Error(`${name}.${key} must be a string`);
    result[key] = entry;
  }
  return result;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Execute one MCP adapter call through the official SDK. Adapter manifests are
 * trusted metadata, but the model never supplies the command, URL or headers.
 */
export async function callMcpAdapter(manifest: JsonObject, call: McpAdapterCall): Promise<JsonObject> {
  if (manifest.kind !== "mcp") throw new Error("adapter is not an MCP adapter");
  if (manifest.status !== undefined && manifest.status !== "active") throw new Error("MCP adapter is not active");
  const meta = metadata(manifest);
  const timeoutMs = Math.max(100, Math.min(3_600_000, Number(call.timeout_ms ?? meta.timeout_ms ?? 120_000)));
  const outputLimit = Math.max(256, Math.min(10_000_000, Number(call.output_limit ?? meta.output_limit ?? 1_000_000)));
  const transportKind = String(meta.transport ?? manifest.transport ?? "stdio").toLowerCase();
  const { Client, StdioClientTransport, StreamableHTTPClientTransport } = await mcpSdk();
  const client = new Client({ name: "craft-native-mcp", version: "1" }, { capabilities: {} });
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (transportKind === "stdio" || transportKind === "local") {
    const command = String(meta.command ?? manifest.entry ?? "");
    if (!command) throw new Error("MCP stdio adapter has no command");
    transport = new StdioClientTransport({
      command,
      args: stringArray(meta.args, "metadata.args"),
      env: { ...process.env, ...stringRecord(meta.env, "metadata.env") } as Record<string, string>,
      stderr: "pipe",
      ...(typeof meta.cwd === "string" ? { cwd: meta.cwd } : {}),
    });
  } else if (transportKind === "http" || transportKind === "streamable-http" || transportKind === "https") {
    const raw = String(meta.url ?? manifest.entry ?? "");
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error("MCP HTTP adapter URL is invalid"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("MCP HTTP adapter URL must use http(s)");
    transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: stringRecord(meta.headers, "metadata.headers") },
    });
  } else {
    throw new Error(`MCP adapter transport is unsupported: ${transportKind}`);
  }
  try {
    await withTimeout(client.connect(transport), timeoutMs, "MCP connect");
    const result = await withTimeout(client.callTool({ name: call.tool, arguments: call.arguments }), timeoutMs, "MCP tools/call");
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) > outputLimit) throw new Error("MCP result exceeds output limit");
    // Best-effort: a server that does not answer tools/list must not fail the call
    // it was actually asked to make, so a missing inventory is reported as absent.
    const inventory = call.include_tool_inventory ? await toolInventory(client, timeoutMs) : null;
    return { adapter_id: call.adapter_id, tool: call.tool, result, result_digest: digestJson(result),
      ...(inventory === null ? {} : { available_tools: inventory }) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

/** Names and descriptions only: the summary says what the server offers, not how to call it. */
async function toolInventory(client: Client, timeoutMs: number): Promise<JsonObject | null> {
  try {
    const listed = await withTimeout(client.listTools(), timeoutMs, "MCP tools/list") as { tools?: unknown };
    const tools = Array.isArray(listed.tools) ? listed.tools as JsonObject[] : [];
    return { count: tools.length, truncated: tools.length > TOOL_INVENTORY_LIMIT,
      tools: tools.slice(0, TOOL_INVENTORY_LIMIT).map((tool) => ({
        name: String(tool.name ?? ""),
        description: tool.description === undefined || tool.description === null ? null : String(tool.description),
      })) };
  } catch { return null; }
}

export async function listMcpAdapterTools(manifest: JsonObject): Promise<JsonObject> {
  if (manifest.kind !== "mcp") throw new Error("adapter is not an MCP adapter");
  const meta = metadata(manifest);
  const transportKind = String(meta.transport ?? manifest.transport ?? "stdio").toLowerCase();
  const { Client, StdioClientTransport, StreamableHTTPClientTransport } = await mcpSdk();
  const client = new Client({ name: "craft-native-mcp", version: "1" }, { capabilities: {} });
  let transport: StdioClientTransport | StreamableHTTPClientTransport;
  if (transportKind === "stdio" || transportKind === "local") {
    const command = String(meta.command ?? manifest.entry ?? "");
    if (!command) throw new Error("MCP stdio adapter has no command");
    transport = new StdioClientTransport({ command, args: stringArray(meta.args, "metadata.args"),
      env: { ...process.env, ...stringRecord(meta.env, "metadata.env") } as Record<string, string>, stderr: "pipe" });
  } else if (transportKind === "http" || transportKind === "streamable-http" || transportKind === "https") {
    const url = new URL(String(meta.url ?? manifest.entry ?? ""));
    transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: stringRecord(meta.headers, "metadata.headers") } });
  } else throw new Error(`MCP adapter transport is unsupported: ${transportKind}`);
  try {
    await client.connect(transport);
    return await client.listTools();
  } finally {
    await client.close().catch(() => undefined);
  }
}

