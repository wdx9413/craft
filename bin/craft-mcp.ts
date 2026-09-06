#!/usr/bin/env node
import { createInterface } from "node:readline";
import { McpServer } from "../src/mcp.ts";
import { CraftService } from "../src/service.ts";
import { CraftStore, type JsonObject } from "../src/store.ts";

const store = await new CraftStore().open();
const server = new McpServer(new CraftService(store));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  let response: JsonObject;
  try { response = await server.handle(JSON.parse(line)) ?? {}; }
  catch { response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }; }
  if (Object.keys(response).length) process.stdout.write(`${JSON.stringify(response)}\n`);
});
input.on("close", () => store.close());
