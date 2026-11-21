import { createInterface } from "node:readline";
import type { McpServer } from "../mcp.ts";
import type { CraftService } from "../application/craft-service.ts";
import type { JsonObject } from "../infrastructure/store.ts";
import { openMcpRuntime } from "./mcp/runtime.ts";

type Mode = string;
type Server = Pick<McpServer, "handle"> & { service?: CraftService };
type Start = (mode: Mode) => Promise<{ server: Server; close: () => void }>;
type BackgroundStop = () => void | Promise<void>;

function parseError(): JsonObject {
  return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
}

export async function serveMcpStdio(options: {
  mode: Mode;
  input: NodeJS.ReadableStream;
  write: (line: string) => void;
  start?: Start;
  afterStart?: (server: Server) => BackgroundStop | undefined | Promise<BackgroundStop | undefined>;
}): Promise<void> {
  const input = createInterface({ input: options.input, crlfDelay: Infinity });
  const pending: string[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  input.on("line", (line) => { pending.push(line); wake?.(); });
  input.on("close", () => { closed = true; wake?.(); });
  let runtime: Awaited<ReturnType<Start>>;
  let stopBackground: BackgroundStop | undefined;
  try { runtime = await (options.start ?? openMcpRuntime)(options.mode); }
  catch (error) { input.close(); options.input.pause(); throw error; }
  try { stopBackground = await options.afterStart?.(runtime.server); }
  catch (error) { runtime.close(); input.close(); options.input.pause(); throw error; }
  try {
    while (pending.length || !closed) {
      if (!pending.length) await new Promise<void>((resolve) => { wake = resolve; });
      wake = undefined;
      const line = pending.shift();
      if (line === undefined) continue;
      let response: JsonObject | undefined;
      try { response = await runtime.server.handle(JSON.parse(line)); }
      catch { response = parseError(); }
      if (response) options.write(`${JSON.stringify(response)}\n`);
    }
  } finally {
    try { await stopBackground?.(); }
    finally { runtime.close(); }
  }
}
