import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { McpServer } from "./mcp.ts";
import { CraftService } from "./service.ts";
import { CraftStore } from "./store.ts";

type Handler = Pick<McpServer, "handle">;
const MAX_BODY = 4 * 1024 * 1024;

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length; if (size > MAX_BODY) throw new Error("MCP request body exceeds 4 MiB");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Streamable-HTTP-compatible JSON request boundary; no credentials or CORS are enabled by default. */
export function createMcpHttpHandler(handler: Handler, options: { path?: string } = {}) {
  const path = options.path ?? "/mcp";
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.url?.split("?")[0] !== path || request.method !== "POST") {
      response.statusCode = request.url?.split("?")[0] === path ? 405 : 404;
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ error: "POST /mcp required" })); return;
    }
    if (request.headers.accept && !String(request.headers.accept).includes("application/json") && !String(request.headers.accept).includes("text/event-stream")) {
      response.statusCode = 406; response.end(JSON.stringify({ error: "Accept must include application/json or text/event-stream" })); return;
    }
    try {
      const raw = await readBody(request); const message = JSON.parse(raw) as unknown; const result = await handler.handle(message);
      response.statusCode = result === undefined ? 202 : 200;
      response.setHeader("content-type", "application/json"); response.setHeader("cache-control", "no-store");
      response.end(result === undefined ? "" : JSON.stringify(result));
    } catch (error) {
      response.statusCode = error instanceof Error && error.message.includes("exceeds") ? 413 : 400;
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  };
}

export async function serveMcpHttp(options: { mode?: string; host?: string; port?: number; path?: string; start?: () => Promise<{ server: Handler; close: () => void }> }): Promise<{ server: Server; close: () => void }> {
  const runtime = await (options.start ?? (async () => { const store = await new CraftStore().open(); return { server: new McpServer(await CraftService.open(store), options.mode ?? "syscall"), close: () => store.close() }; }))();
  const http = createServer(createMcpHttpHandler(runtime.server, { path: options.path }));
  await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(options.port ?? 8787, options.host ?? "127.0.0.1", () => { http.removeListener("error", reject); resolve(); }); });
  return { server: http, close: () => { http.close(); runtime.close(); } };
}
