#!/usr/bin/env node
import { createInterface } from "node:readline";
import { McpServer } from "../src/mcp.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

async function main(): Promise<void> {
  const store = await new CraftStore().open();
  const server = new McpServer(new CraftService(store));
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      let response: JsonObject | undefined;
      try { response = await server.handle(JSON.parse(line)); }
      catch { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }; }
      if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  } finally { store.close(); }
}

main().catch(() => {
  process.stderr.write("Craft MCP failed to start.\n");
  process.exitCode = 1;
});
