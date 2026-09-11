import { createInterface } from "node:readline";
import { McpServer } from "./mcp.ts";
import { CraftService } from "./service.ts";
import { CraftStore, type JsonObject } from "./store.ts";

type Mode = "core" | "full";
type Server = Pick<McpServer, "handle">;
type Start = (mode: Mode) => Promise<{ server: Server; close: () => void }>;

async function start(mode: Mode): Promise<{ server: Server; close: () => void }> {
  const store = await new CraftStore().open();
  return { server: new McpServer(await CraftService.open(store), mode), close: () => store.close() };
}

function parseError(): JsonObject {
  return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
}

export async function serveMcpStdio(options: {
  mode: Mode;
  input: NodeJS.ReadableStream;
  write: (line: string) => void;
  start?: Start;
}): Promise<void> {
  const input = createInterface({ input: options.input, crlfDelay: Infinity });
  const pending: string[] = [];
  let closed = false;
  let wake: (() => void) | undefined;
  input.on("line", (line) => { pending.push(line); wake?.(); });
  input.on("close", () => { closed = true; wake?.(); });
  const runtime = await (options.start ?? start)(options.mode);
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
  } finally { runtime.close(); }
}
