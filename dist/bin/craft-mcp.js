#!/usr/bin/env node
import { createInterface } from "node:readline";
import { McpServer } from "../src/mcp.js";
import { CraftService } from "../src/service.js";
import { CraftStore } from "../src/store.js";
const store = await new CraftStore().open();
const server = new McpServer(new CraftService(store));
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
    let response;
    try {
        response = await server.handle(JSON.parse(line)) ?? {};
    }
    catch {
        response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    }
    if (Object.keys(response).length)
        process.stdout.write(`${JSON.stringify(response)}\n`);
});
input.on("close", () => store.close());
//# sourceMappingURL=craft-mcp.js.map